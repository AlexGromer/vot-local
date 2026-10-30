// Test host for vot_local.dll: a fake AIMP core with just the services the plugin uses.
// Usage: host.exe <plugin.dll> <input file>; exit code 0 when the plugin added <input>.ru.m4a.

#include <windows.h>

#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "apiActions.h"
#include "apiCore.h"
#include "apiMenu.h"
#include "apiObjects.h"
#include "apiPlaylists.h"
#include "apiPlugin.h"
#include "apiThreading.h"

namespace {

DWORD g_mainThread = 0;
bool g_offThreadCall = false;
struct Queued {
  IAIMPTask* task;
  HANDLE done;
};
std::vector<Queued> g_tasks;
CRITICAL_SECTION g_lock;

void CheckMainThread() {
  if (GetCurrentThreadId() != g_mainThread) {
    g_offThreadCall = true;
  }
}

template <typename Interface>
class Fake : public Interface {
 public:
  explicit Fake(const IID* iid) : iid_(iid) {}
  virtual ~Fake() = default;
  HRESULT WINAPI QueryInterface(REFIID riid, void** obj) override {
    if (IsEqualIID(riid, IID_IUnknown) || (iid_ && IsEqualIID(riid, *iid_))) {
      *obj = static_cast<Interface*>(this);
      this->AddRef();
      return S_OK;
    }
    *obj = nullptr;
    return E_NOINTERFACE;
  }
  ULONG WINAPI AddRef() override { return InterlockedIncrement(&refs_); }
  ULONG WINAPI Release() override {
    LONG left = InterlockedDecrement(&refs_);
    if (!left) {
      delete this;
    }
    return left;
  }

 private:
  const IID* iid_;
  LONG refs_ = 1;
};

class FakeString : public Fake<IAIMPString> {
 public:
  explicit FakeString(std::wstring text = L"")
      : Fake(&IID_IAIMPString), text_(std::move(text)) {}
  HRESULT WINAPI GetChar(int, TChar*) override { return E_NOTIMPL; }
  TChar* WINAPI GetData() override { return text_.data(); }
  int WINAPI GetLength() override { return static_cast<int>(text_.size()); }
  int WINAPI GetHashCode() override { return 0; }
  HRESULT WINAPI SetChar(int, TChar) override { return E_NOTIMPL; }
  HRESULT WINAPI SetData(TChar* chars, int count) override {
    text_.assign(chars, count);
    return S_OK;
  }
  HRESULT WINAPI Add(IAIMPString*) override { return E_NOTIMPL; }
  HRESULT WINAPI Add2(TChar*, int) override { return E_NOTIMPL; }
  HRESULT WINAPI ChangeCase(int) override { return E_NOTIMPL; }
  HRESULT WINAPI Clone(IAIMPString**) override { return E_NOTIMPL; }
  HRESULT WINAPI Compare(IAIMPString*, int*, BOOL) override { return E_NOTIMPL; }
  HRESULT WINAPI Compare2(TChar*, int, int*, BOOL) override { return E_NOTIMPL; }
  HRESULT WINAPI Delete(int, int) override { return E_NOTIMPL; }
  HRESULT WINAPI Find(IAIMPString*, int*, int, int) override { return E_NOTIMPL; }
  HRESULT WINAPI Find2(TChar*, int, int*, int, int) override { return E_NOTIMPL; }
  HRESULT WINAPI Insert(int, IAIMPString*) override { return E_NOTIMPL; }
  HRESULT WINAPI Insert2(int, TChar*, int) override { return E_NOTIMPL; }
  HRESULT WINAPI Replace(IAIMPString*, IAIMPString*, int) override { return E_NOTIMPL; }
  HRESULT WINAPI Replace2(TChar*, int, TChar*, int, int) override { return E_NOTIMPL; }
  HRESULT WINAPI SubString(int, int, IAIMPString**) override { return E_NOTIMPL; }

 private:
  std::wstring text_;
};

class FakeMenuItem : public Fake<IAIMPMenuItem> {
 public:
  FakeMenuItem() : Fake(&IID_IAIMPMenuItem) {}
  ~FakeMenuItem() override {
    for (auto& kv : objects_) {
      kv.second->Release();
    }
  }
  void WINAPI BeginUpdate() override {}
  void WINAPI EndUpdate() override {}
  HRESULT WINAPI Reset() override { return S_OK; }
  HRESULT WINAPI GetValueAsFloat(int, double*) override { return E_NOTIMPL; }
  HRESULT WINAPI GetValueAsInt32(int id, int* value) override {
    *value = ints_[id];
    return S_OK;
  }
  HRESULT WINAPI GetValueAsInt64(int, INT64*) override { return E_NOTIMPL; }
  HRESULT WINAPI GetValueAsObject(int id, REFIID iid, void** value) override {
    auto it = objects_.find(id);
    if (it == objects_.end()) {
      return E_FAIL;
    }
    return it->second->QueryInterface(iid, value);
  }
  HRESULT WINAPI SetValueAsFloat(int, const double) override { return E_NOTIMPL; }
  HRESULT WINAPI SetValueAsInt32(int id, int value) override {
    ints_[id] = value;
    return S_OK;
  }
  HRESULT WINAPI SetValueAsInt64(int, const INT64) override { return E_NOTIMPL; }
  HRESULT WINAPI SetValueAsObject(int id, IUnknown* value) override {
    if (!value) {
      return E_INVALIDARG;
    }
    value->AddRef();
    auto it = objects_.find(id);
    if (it != objects_.end()) {
      it->second->Release();
    }
    objects_[id] = value;
    return S_OK;
  }
  HRESULT WINAPI DeleteChildren() override { return S_OK; }

  std::wstring Text(int id) {
    IAIMPString* str = nullptr;
    if (FAILED(GetValueAsObject(id, IID_IAIMPString, reinterpret_cast<void**>(&str)))) {
      return L"";
    }
    std::wstring text(str->GetData(), str->GetLength());
    str->Release();
    return text;
  }

 private:
  std::map<int, IUnknown*> objects_;
  std::map<int, int> ints_;
};

class FakeObjectList : public Fake<IAIMPObjectList> {
 public:
  FakeObjectList() : Fake(nullptr) {}
  ~FakeObjectList() override {
    for (IUnknown* obj : items_) {
      obj->Release();
    }
  }
  HRESULT WINAPI Add(IUnknown* obj) override {
    obj->AddRef();
    items_.push_back(obj);
    return S_OK;
  }
  HRESULT WINAPI Clear() override { return E_NOTIMPL; }
  HRESULT WINAPI Delete(int) override { return E_NOTIMPL; }
  HRESULT WINAPI Insert(int, IUnknown*) override { return E_NOTIMPL; }
  int WINAPI GetCount() override { return static_cast<int>(items_.size()); }
  HRESULT WINAPI GetObject(int index, REFIID iid, void** obj) override {
    return items_.at(index)->QueryInterface(iid, obj);
  }
  HRESULT WINAPI SetObject(int, IUnknown*) override { return E_NOTIMPL; }

 private:
  std::vector<IUnknown*> items_;
};

class FakePlaylistProps : public FakeMenuItem {
 public:
  FakePlaylistProps() { SetId(); }
  HRESULT WINAPI QueryInterface(REFIID riid, void** obj) override {
    if (IsEqualIID(riid, IID_IAIMPPropertyList) || IsEqualIID(riid, IID_IUnknown)) {
      *obj = static_cast<IAIMPPropertyList*>(this);
      AddRef();
      return S_OK;
    }
    *obj = nullptr;
    return E_NOINTERFACE;
  }

 private:
  void SetId() {
    FakeString* id = new FakeString(L"playlist-1");
    SetValueAsObject(AIMP_PLAYLIST_PROPID_ID, id);
    id->Release();
  }
};

class FakePlaylist : public Fake<IAIMPPlaylist> {
 public:
  explicit FakePlaylist(std::vector<std::wstring> selected)
      : Fake(&IID_IAIMPPlaylist), selected_(std::move(selected)) {}
  ~FakePlaylist() override { props_->Release(); }
  HRESULT WINAPI QueryInterface(REFIID riid, void** obj) override {
    if (IsEqualIID(riid, IID_IAIMPPropertyList)) {
      return props_->QueryInterface(riid, obj);
    }
    return Fake::QueryInterface(riid, obj);
  }
  HRESULT WINAPI Add(IUnknown* obj, LongWord flags, int insertIn) override {
    CheckMainThread();
    IAIMPString* str = nullptr;
    if (FAILED(obj->QueryInterface(IID_IAIMPString, reinterpret_cast<void**>(&str)))) {
      return E_INVALIDARG;
    }
    added.emplace_back(str->GetData(), str->GetLength());
    addFlags = flags;
    addPosition = insertIn;
    str->Release();
    return S_OK;
  }
  HRESULT WINAPI AddList(IAIMPObjectList*, LongWord, int) override { return E_NOTIMPL; }
  HRESULT WINAPI Delete(IAIMPPlaylistItem*) override { return E_NOTIMPL; }
  HRESULT WINAPI Delete2(int) override { return E_NOTIMPL; }
  HRESULT WINAPI Delete3(LongWord, TAIMPPlaylistDeleteProc, void*) override { return E_NOTIMPL; }
  HRESULT WINAPI DeleteAll() override { return E_NOTIMPL; }
  HRESULT WINAPI Sort(int) override { return E_NOTIMPL; }
  HRESULT WINAPI Sort2(IAIMPString*) override { return E_NOTIMPL; }
  HRESULT WINAPI Sort3(TAIMPPlaylistCompareProc*, void*) override { return E_NOTIMPL; }
  HRESULT WINAPI BeginUpdate() override { return E_NOTIMPL; }
  HRESULT WINAPI EndUpdate() override { return E_NOTIMPL; }
  HRESULT WINAPI Close(LongWord) override { return E_NOTIMPL; }
  HRESULT WINAPI GetFiles(LongWord flags, IAIMPObjectList** list) override {
    CheckMainThread();
    getFilesFlags = flags;
    FakeObjectList* files = new FakeObjectList();
    for (const std::wstring& path : selected_) {
      FakeString* file = new FakeString(path);
      files->Add(file);
      file->Release();
    }
    *list = files;
    return S_OK;
  }
  HRESULT WINAPI MergeGroup(IAIMPPlaylistGroup*) override { return E_NOTIMPL; }
  HRESULT WINAPI ReloadFromPreimage() override { return E_NOTIMPL; }
  HRESULT WINAPI ReloadInfo(LongWord) override { return E_NOTIMPL; }
  HRESULT WINAPI GetItem(int, REFIID, void**) override { return E_NOTIMPL; }
  int WINAPI GetItemCount() override { return 0; }
  HRESULT WINAPI GetGroup(int, REFIID, void**) override { return E_NOTIMPL; }
  int WINAPI GetGroupCount() override { return 0; }
  HRESULT WINAPI ListenerAdd(IAIMPPlaylistListener*) override { return E_NOTIMPL; }
  HRESULT WINAPI ListenerRemove(IAIMPPlaylistListener*) override { return E_NOTIMPL; }

  std::vector<std::wstring> added;
  LongWord addFlags = 0;
  int addPosition = 0;
  LongWord getFilesFlags = 0;

 private:
  std::vector<std::wstring> selected_;
  FakePlaylistProps* props_ = new FakePlaylistProps();
};

class FakePlaylists : public Fake<IAIMPServicePlaylistManager> {
 public:
  explicit FakePlaylists(FakePlaylist* playlist)
      : Fake(&IID_IAIMPServicePlaylistManager), playlist_(playlist) {}
  HRESULT WINAPI CreatePlaylist(IAIMPString*, BOOL, IAIMPPlaylist**) override { return E_NOTIMPL; }
  HRESULT WINAPI CreatePlaylistFromFile(IAIMPString*, BOOL, IAIMPPlaylist**) override { return E_NOTIMPL; }
  HRESULT WINAPI GetActivePlaylist(IAIMPPlaylist** playlist) override {
    playlist_->AddRef();
    *playlist = playlist_;
    return S_OK;
  }
  HRESULT WINAPI SetActivePlaylist(IAIMPPlaylist*) override { return E_NOTIMPL; }
  HRESULT WINAPI GetPlayingPlaylist(IAIMPPlaylist**) override { return E_NOTIMPL; }
  HRESULT WINAPI GetLoadedPlaylist(int, IAIMPPlaylist**) override { return E_NOTIMPL; }
  HRESULT WINAPI GetLoadedPlaylistByName(IAIMPString*, IAIMPPlaylist**) override { return E_NOTIMPL; }
  int WINAPI GetLoadedPlaylistCount() override { return 1; }
  HRESULT WINAPI GetLoadedPlaylistByID(IAIMPString* id, IAIMPPlaylist** playlist) override {
    CheckMainThread();
    if (std::wstring(id->GetData(), id->GetLength()) != L"playlist-1") {
      return E_FAIL;
    }
    playlist_->AddRef();
    *playlist = playlist_;
    return S_OK;
  }

 private:
  FakePlaylist* playlist_;
};

class FakeThreads : public Fake<IAIMPServiceThreads> {
 public:
  FakeThreads() : Fake(&IID_IAIMPServiceThreads) {}
  HRESULT WINAPI ExecuteInMainThread(IAIMPTask* task, LongWord flags) override {
    if (GetCurrentThreadId() == g_mainThread) {
      task->Execute(nullptr);
      return S_OK;
    }
    bool wait = flags & AIMP_SERVICE_THREADS_FLAGS_WAITFOR;
    HANDLE done = wait ? CreateEventW(nullptr, TRUE, FALSE, nullptr) : nullptr;
    task->AddRef();
    EnterCriticalSection(&g_lock);
    g_tasks.push_back({task, done});
    LeaveCriticalSection(&g_lock);
    if (done) {
      WaitForSingleObject(done, INFINITE);
      CloseHandle(done);
    }
    return S_OK;
  }
  HRESULT WINAPI ExecuteInThread(IAIMPTask*, TTaskHandle*) override { return E_NOTIMPL; }
  HRESULT WINAPI Cancel(TTaskHandle, LongWord) override { return E_NOTIMPL; }
  HRESULT WINAPI WaitFor(TTaskHandle) override { return E_NOTIMPL; }
};

class FakeMenus : public Fake<IAIMPServiceMenuManager> {
 public:
  FakeMenus() : Fake(&IID_IAIMPServiceMenuManager) {}
  HRESULT WINAPI GetBuiltIn(int id, IAIMPMenuItem** item) override {
    builtInAsked = id;
    builtIn.AddRef();
    *item = &builtIn;
    return S_OK;
  }
  HRESULT WINAPI GetByID(IAIMPString*, IAIMPMenuItem**) override { return E_NOTIMPL; }
  int builtInAsked = -1;
  FakeMenuItem builtIn;
};

class FakeCore : public Fake<IAIMPCore> {
 public:
  explicit FakeCore(FakePlaylist* playlist)
      : Fake(nullptr), playlists_(playlist) {
    menus_.AddRef();
    playlists_.AddRef();
    threads_.AddRef();
  }
  HRESULT WINAPI QueryInterface(REFIID riid, void** obj) override {
    IUnknown* service = nullptr;
    if (IsEqualIID(riid, IID_IAIMPServiceMenuManager)) {
      service = &menus_;
    } else if (IsEqualIID(riid, IID_IAIMPServicePlaylistManager)) {
      service = &playlists_;
    } else if (IsEqualIID(riid, IID_IAIMPServiceThreads)) {
      service = &threads_;
    }
    if (service) {
      service->AddRef();
      *obj = service;
      return S_OK;
    }
    return Fake::QueryInterface(riid, obj);
  }
  HRESULT WINAPI CreateObject(REFIID iid, void** obj) override {
    if (IsEqualIID(iid, IID_IAIMPString)) {
      *obj = static_cast<IAIMPString*>(new FakeString());
      return S_OK;
    }
    if (IsEqualIID(iid, IID_IAIMPMenuItem)) {
      *obj = static_cast<IAIMPMenuItem*>(new FakeMenuItem());
      return S_OK;
    }
    return E_NOINTERFACE;
  }
  HRESULT WINAPI GetPath(int, IAIMPString**) override { return E_NOTIMPL; }
  HRESULT WINAPI RegisterExtension(REFIID service, IUnknown* extension) override {
    if (IsEqualIID(service, IID_IAIMPServiceMenuManager)) {
      extension->AddRef();
      registered.push_back(static_cast<FakeMenuItem*>(
          static_cast<IAIMPMenuItem*>(extension)));
    }
    return S_OK;
  }
  HRESULT WINAPI RegisterService(IUnknown*) override { return E_NOTIMPL; }
  HRESULT WINAPI UnregisterExtension(IUnknown*) override { return S_OK; }

  std::vector<FakeMenuItem*> registered;
  FakeMenus menus_;

 private:
  FakePlaylists playlists_;
  FakeThreads threads_;
};

void PumpTasks() {
  std::vector<Queued> tasks;
  EnterCriticalSection(&g_lock);
  tasks.swap(g_tasks);
  LeaveCriticalSection(&g_lock);
  for (Queued& q : tasks) {
    q.task->Execute(nullptr);
    q.task->Release();
    if (q.done) {
      SetEvent(q.done);
    }
  }
}

int Fail(const char* what) {
  std::printf("FAIL: %s\n", what);
  return 1;
}

bool Touch(const std::wstring& path) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr,
                            CREATE_ALWAYS, 0, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    return false;
  }
  CloseHandle(file);
  return true;
}

void PumpFor(int ms) {
  for (int waited = 0; waited < ms; waited += 50) {
    PumpTasks();
    Sleep(50);
  }
}

}  // namespace

// Usage: host.exe <plugin.dll> <work dir> <normal|finalize>
int wmain(int argc, wchar_t** argv) {
  if (argc != 4) {
    return Fail("usage: host.exe <plugin.dll> <work dir> <normal|finalize>");
  }
  std::wstring mode = argv[3];
  g_mainThread = GetCurrentThreadId();
  InitializeCriticalSection(&g_lock);

  std::wstring dir = argv[2];
  std::wstring input =
      dir + (mode == L"finalize" ? L"\\slow лекция 1.mp4" : L"\\лекция 1.mp4");
  if (!Touch(input)) {
    return Fail("cannot create the input file");
  }

  HMODULE dll = LoadLibraryW(argv[1]);
  if (!dll) {
    return Fail("LoadLibrary");
  }
  auto getHeader = reinterpret_cast<TAIMPPluginGetHeaderProc>(
      GetProcAddress(dll, "AIMPPluginGetHeader"));
  if (!getHeader) {
    return Fail("AIMPPluginGetHeader is not exported");
  }
  IAIMPPlugin* plugin = nullptr;
  if (FAILED(getHeader(&plugin)) || !plugin) {
    return Fail("AIMPPluginGetHeader");
  }
  if (plugin->InfoGetCategories() != AIMP_PLUGIN_CATEGORY_ADDONS ||
      !plugin->InfoGet(AIMP_PLUGIN_INFO_NAME)) {
    return Fail("plugin info");
  }

  // The selection holds the file twice, a URL and a missing file; only one run is expected.
  FakePlaylist* playlist = new FakePlaylist(
      {input, L"http://example.com/a.mp3", dir + L"\\missing.mp4", input});
  FakeCore* core = new FakeCore(playlist);
  if (FAILED(plugin->Initialize(core))) {
    return Fail("Initialize");
  }
  if (core->registered.size() != 1) {
    return Fail("expected one menu item");
  }
  FakeMenuItem* item = core->registered[0];
  if (core->menus_.builtInAsked != AIMP_MENUID_PLAYER_PLAYLIST_CONTEXT_FUNCTIONS) {
    return Fail("menu parent is not the playlist context menu");
  }
  if (item->Text(AIMP_MENUITEM_PROPID_CAPTION) != L"Перевести (VOT)" ||
      item->Text(AIMP_MENUITEM_PROPID_ID) != L"vot-local.translate") {
    return Fail("menu caption or id");
  }
  IAIMPActionEvent* event = nullptr;
  if (FAILED(item->GetValueAsObject(AIMP_MENUITEM_PROPID_EVENT,
                                    IID_IAIMPActionEvent,
                                    reinterpret_cast<void**>(&event)))) {
    return Fail("menu event");
  }
  event->OnExecute(nullptr);
  if (playlist->getFilesFlags != AIMP_PLAYLIST_GETFILES_FLAGS_SELECTED_ONLY) {
    return Fail("GetFiles must ask for selected files only");
  }

  if (mode == L"finalize") {
    // AIMP shuts down while vot-local.exe is still running.
    event->Release();
    plugin->Finalize();
    plugin->Release();
    FreeLibrary(dll);
    PumpFor(6000);
    if (!playlist->added.empty()) {
      return Fail("a result was added after Finalize");
    }
    std::printf("PASS finalize\n");
    return 0;
  }

  for (int i = 0; i < 300 && playlist->added.empty(); i++) {
    PumpFor(100);
  }
  // A second click while the first run is still pending must not start the file again.
  PumpFor(500);
  std::wstring expected = input + L".ru.m4a";
  if (playlist->added.size() != 1 || playlist->added[0] != expected) {
    std::printf("added %zu:\n", playlist->added.size());
    for (const std::wstring& a : playlist->added) {
      std::printf("  %ls\n", a.c_str());
    }
    return Fail("expected exactly one translated file in the playlist");
  }
  if (playlist->addPosition != -1 || playlist->addFlags != 0) {
    return Fail("Add flags or position");
  }
  if (g_offThreadCall) {
    return Fail("playlist was used outside the main thread");
  }
  event->OnExecute(nullptr);
  for (int i = 0; i < 300 && playlist->added.size() < 2; i++) {
    PumpFor(100);
  }
  if (playlist->added.size() != 2) {
    return Fail("the file can be translated again once the first run finished");
  }
  event->Release();
  plugin->Finalize();
  plugin->Release();
  std::printf("PASS normal\n");
  return 0;
}
