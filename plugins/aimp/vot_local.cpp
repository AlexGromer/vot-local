// AIMP plugin: "Перевести (VOT)" in the playlist context menu runs vot-local.exe on the
// selected files and adds the dubbed <name>.<lang>.m4a to the same playlist.
//
// Threading: AIMP objects are touched on the main thread only. The worker thread sees
// plain strings, runs vot-local.exe and hands each result back through
// IAIMPServiceThreads::ExecuteInMainThread with WAITFOR, so no task outlives its worker.

#include <windows.h>

#include <set>
#include <string>
#include <utility>
#include <vector>

#include "apiActions.h"
#include "apiCore.h"
#include "apiMenu.h"
#include "apiObjects.h"
#include "apiPlaylists.h"
#include "apiPlugin.h"
#include "apiThreading.h"

namespace {

const wchar_t kMenuId[] = L"vot-local.translate";
const wchar_t kCaption[] = L"Перевести (VOT)";
const wchar_t kSettingsKey[] = L"Software\\vot-local";

// Minimal COM object for a single interface; the reference count starts at 1.
template <typename Interface>
class ComObject : public Interface {
 public:
  explicit ComObject(const IID* iid) : iid_(iid) {}
  virtual ~ComObject() = default;

  HRESULT WINAPI QueryInterface(REFIID riid, void** obj) override {
    if (!obj) {
      return E_POINTER;
    }
    if (IsEqualIID(riid, IID_IUnknown) || (iid_ && IsEqualIID(riid, *iid_))) {
      *obj = static_cast<Interface*>(this);
      AddRef();
      return S_OK;
    }
    *obj = nullptr;
    return E_NOINTERFACE;
  }

  ULONG WINAPI AddRef() override { return InterlockedIncrement(&refs_); }

  ULONG WINAPI Release() override {
    LONG left = InterlockedDecrement(&refs_);
    if (left == 0) {
      delete this;
    }
    return left;
  }

 private:
  const IID* iid_;
  LONG refs_ = 1;
};

template <typename T>
class Ref {
 public:
  Ref() = default;
  Ref(const Ref&) = delete;
  Ref& operator=(const Ref&) = delete;
  ~Ref() { reset(); }

  void reset() {
    if (ptr_) {
      ptr_->Release();
      ptr_ = nullptr;
    }
  }
  T* get() const { return ptr_; }
  T* operator->() const { return ptr_; }
  T** put() {
    reset();
    return &ptr_;
  }
  void** putVoid() { return reinterpret_cast<void**>(put()); }
  explicit operator bool() const { return ptr_ != nullptr; }

 private:
  T* ptr_ = nullptr;
};

// Shared state. g_core and g_threads are set in Initialize and read under g_lock.
SRWLOCK g_lock = SRWLOCK_INIT;
IAIMPCore* g_core = nullptr;
IAIMPServiceThreads* g_threads = nullptr;
volatile LONG g_shutdown = 0;
LONG g_workers = 0;
std::set<std::wstring> g_inProgress;

bool ShuttingDown() { return InterlockedCompareExchange(&g_shutdown, 0, 0) != 0; }

std::wstring ToString(IAIMPString* str) {
  return str ? std::wstring(str->GetData(), str->GetLength()) : std::wstring();
}

// Main thread only.
bool MakeString(const std::wstring& text, Ref<IAIMPString>* out) {
  if (g_core &&
      SUCCEEDED(g_core->CreateObject(IID_IAIMPString, out->putVoid())) &&
      SUCCEEDED((*out)->SetData(const_cast<wchar_t*>(text.c_str()),
                                static_cast<int>(text.size())))) {
    return true;
  }
  out->reset();
  return false;
}

// RRF_RT_REG_SZ also accepts REG_EXPAND_SZ and expands it; adding RRF_RT_REG_EXPAND_SZ
// without RRF_NOEXPAND makes the call fail.
std::wstring ReadSetting(const wchar_t* name) {
  DWORD size = 0;
  if (RegGetValueW(HKEY_CURRENT_USER, kSettingsKey, name,
                   RRF_RT_REG_SZ, nullptr, nullptr,
                   &size) != ERROR_SUCCESS ||
      size < sizeof(wchar_t)) {
    return std::wstring();
  }
  std::wstring value(size / sizeof(wchar_t), L'\0');
  if (RegGetValueW(HKEY_CURRENT_USER, kSettingsKey, name,
                   RRF_RT_REG_SZ, nullptr, value.data(),
                   &size) != ERROR_SUCCESS) {
    return std::wstring();
  }
  value.resize(wcsnlen(value.c_str(), value.size()));
  return value;
}

// Only absolute file paths are quoted here; they never contain quotes or end in a backslash.
std::wstring Quote(const std::wstring& arg) { return L"\"" + arg + L"\""; }

void ShowMessage(const std::wstring& text) {
  MessageBoxW(nullptr, text.c_str(), L"VOT",
              MB_OK | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST);
}

bool IsRegularFile(const std::wstring& path) {
  DWORD attrs = GetFileAttributesW(path.c_str());
  return attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY);
}

std::wstring ReadUtf8File(const std::wstring& path) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ,
                            nullptr, OPEN_EXISTING, 0, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    return std::wstring();
  }
  std::string bytes;
  char chunk[4096];
  DWORD read = 0;
  while (ReadFile(file, chunk, sizeof(chunk), &read, nullptr) && read > 0) {
    bytes.append(chunk, read);
  }
  CloseHandle(file);
  int len = MultiByteToWideChar(CP_UTF8, 0, bytes.data(),
                                static_cast<int>(bytes.size()), nullptr, 0);
  std::wstring text(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, bytes.data(), static_cast<int>(bytes.size()),
                      text.data(), len);
  return text;
}

// Runs on the main thread: adds the result to the playlist it was requested from.
class AddToPlaylistTask : public ComObject<IAIMPTask> {
 public:
  AddToPlaylistTask(std::wstring playlistId, std::wstring file)
      : ComObject(&IID_IAIMPTask),
        playlistId_(std::move(playlistId)),
        file_(std::move(file)) {}

  void WINAPI Execute(IAIMPTaskOwner*) override {
    if (ShuttingDown() || !g_core) {
      return;
    }
    Ref<IAIMPServicePlaylistManager> playlists;
    Ref<IAIMPPlaylist> playlist;
    Ref<IAIMPString> id;
    Ref<IAIMPString> name;
    if (FAILED(g_core->QueryInterface(IID_IAIMPServicePlaylistManager,
                                      playlists.putVoid()))) {
      return;
    }
    if (!MakeString(playlistId_, &id) ||
        FAILED(playlists->GetLoadedPlaylistByID(id.get(), playlist.put())) ||
        !playlist) {
      // The playlist was closed meanwhile: use the active one.
      playlists->GetActivePlaylist(playlist.put());
    }
    if (!playlist || !MakeString(file_, &name) ||
        FAILED(playlist->Add(name.get(), 0, -1))) {
      ShowMessage(L"Перевод готов, но его не удалось добавить в плейлист:\n" +
                  file_);
    }
  }

 private:
  std::wstring playlistId_;
  std::wstring file_;
};

struct Job {
  HMODULE module;
  std::wstring playlistId;
  std::vector<std::wstring> files;
};

enum class Result { kOk, kFailed, kNoTool };

Result RunTranslation(const std::wstring& file, std::wstring* output) {
  std::wstring dir = ReadSetting(L"InstallPath");
  std::wstring exe = dir + L"\\vot-local.exe";
  if (dir.empty() || !IsRegularFile(exe)) {
    return Result::kNoTool;
  }

  wchar_t tempDir[MAX_PATH];
  wchar_t resultFile[MAX_PATH];
  if (!GetTempPathW(MAX_PATH, tempDir) ||
      !GetTempFileNameW(tempDir, L"vot", 0, resultFile)) {
    return Result::kFailed;
  }

  std::wstring cmd = Quote(exe) +
                     L" --format m4a --pause-on-error --result-file " +
                     Quote(resultFile) + L" " + Quote(file);
  std::vector<wchar_t> cmdLine(cmd.begin(), cmd.end());
  cmdLine.push_back(L'\0');

  STARTUPINFOW si = {};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi = {};
  // A console of its own shows the progress and, on failure, keeps the error on screen.
  if (!CreateProcessW(exe.c_str(), cmdLine.data(), nullptr, nullptr, FALSE,
                      CREATE_NEW_CONSOLE, nullptr, dir.c_str(), &si, &pi)) {
    DeleteFileW(resultFile);
    return Result::kFailed;
  }
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);

  *output = ReadUtf8File(resultFile);
  DeleteFileW(resultFile);
  return code == 0 && !output->empty() ? Result::kOk : Result::kFailed;
}

// Hands the task to the main thread unless the plugin is being finalized.
void PostToMainThread(IAIMPTask* task) {
  AcquireSRWLockShared(&g_lock);
  IAIMPServiceThreads* threads = ShuttingDown() ? nullptr : g_threads;
  if (threads) {
    threads->AddRef();
  }
  ReleaseSRWLockShared(&g_lock);
  if (threads) {
    threads->ExecuteInMainThread(task, AIMP_SERVICE_THREADS_FLAGS_WAITFOR);
    threads->Release();
  }
}

DWORD WINAPI Worker(void* param) {
  Job* job = static_cast<Job*>(param);
  HMODULE module = job->module;
  for (const std::wstring& file : job->files) {
    if (ShuttingDown()) {
      break;
    }
    std::wstring output;
    Result result = RunTranslation(file, &output);
    if (result == Result::kNoTool) {
      ShowMessage(L"Не найден vot-local.exe. Запустите install.cmd из папки VOT-local.");
      break;
    }
    if (result == Result::kOk) {
      AddToPlaylistTask* task = new AddToPlaylistTask(job->playlistId, output);
      PostToMainThread(task);
      task->Release();
    }
  }

  AcquireSRWLockExclusive(&g_lock);
  for (const std::wstring& file : job->files) {
    g_inProgress.erase(file);
  }
  ReleaseSRWLockExclusive(&g_lock);
  delete job;
  InterlockedDecrement(&g_workers);
  // The plugin may be unloaded while a translation runs; the thread holds its own module reference.
  FreeLibraryAndExitThread(module, 0);
  return 0;
}

std::wstring PlaylistId(IAIMPPlaylist* playlist) {
  Ref<IAIMPPropertyList> props;
  Ref<IAIMPString> id;
  if (SUCCEEDED(playlist->QueryInterface(IID_IAIMPPropertyList,
                                         props.putVoid())) &&
      SUCCEEDED(props->GetValueAsObject(AIMP_PLAYLIST_PROPID_ID,
                                        IID_IAIMPString, id.putVoid()))) {
    return ToString(id.get());
  }
  return std::wstring();
}

std::vector<std::wstring> SelectedFiles(IAIMPPlaylist* playlist) {
  std::vector<std::wstring> files;
  Ref<IAIMPObjectList> list;
  if (FAILED(playlist->GetFiles(AIMP_PLAYLIST_GETFILES_FLAGS_SELECTED_ONLY,
                                list.put())) ||
      !list) {
    return files;
  }
  for (int i = 0; i < list->GetCount(); i++) {
    Ref<IAIMPString> name;
    if (SUCCEEDED(list->GetObject(i, IID_IAIMPString, name.putVoid()))) {
      // URLs, CUE tracks and missing files cannot be translated.
      std::wstring path = ToString(name.get());
      if (IsRegularFile(path)) {
        files.push_back(path);
      }
    }
  }
  return files;
}

class TranslateAction : public ComObject<IAIMPActionEvent> {
 public:
  TranslateAction() : ComObject(&IID_IAIMPActionEvent) {}

  void WINAPI OnExecute(IUnknown*) override {
    if (ShuttingDown() || !g_core) {
      return;
    }
    Ref<IAIMPServicePlaylistManager> playlists;
    Ref<IAIMPPlaylist> playlist;
    if (FAILED(g_core->QueryInterface(IID_IAIMPServicePlaylistManager,
                                      playlists.putVoid())) ||
        FAILED(playlists->GetActivePlaylist(playlist.put())) || !playlist) {
      return;
    }

    Job* job = new Job{nullptr, PlaylistId(playlist.get()), {}};
    AcquireSRWLockExclusive(&g_lock);
    for (const std::wstring& file : SelectedFiles(playlist.get())) {
      if (g_inProgress.insert(file).second) {
        job->files.push_back(file);
      }
    }
    ReleaseSRWLockExclusive(&g_lock);
    if (job->files.empty()) {
      delete job;
      ShowMessage(L"Выберите в плейлисте файл с компьютера (видео или аудио).");
      return;
    }

    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                            reinterpret_cast<LPCWSTR>(&Worker), &job->module)) {
      Forget(job);
      return;
    }
    InterlockedIncrement(&g_workers);
    HANDLE thread = CreateThread(nullptr, 0, Worker, job, 0, nullptr);
    if (thread) {
      CloseHandle(thread);
      return;
    }
    InterlockedDecrement(&g_workers);
    FreeLibrary(job->module);
    Forget(job);
  }

 private:
  static void Forget(Job* job) {
    AcquireSRWLockExclusive(&g_lock);
    for (const std::wstring& file : job->files) {
      g_inProgress.erase(file);
    }
    ReleaseSRWLockExclusive(&g_lock);
    delete job;
  }
};

class Plugin : public ComObject<IAIMPPlugin> {
 public:
  Plugin() : ComObject(nullptr) {}

  TChar* WINAPI InfoGet(int index) override {
    switch (index) {
      case AIMP_PLUGIN_INFO_NAME:
        return const_cast<TChar*>(L"VOT: закадровый перевод");
      case AIMP_PLUGIN_INFO_AUTHOR:
        return const_cast<TChar*>(L"AlexGromer");
      case AIMP_PLUGIN_INFO_SHORT_DESCRIPTION:
        return const_cast<TChar*>(
            L"Переводит выбранные файлы через vot-local и добавляет озвучку в плейлист");
      default:
        return nullptr;
    }
  }

  LongWord WINAPI InfoGetCategories() override {
    return AIMP_PLUGIN_CATEGORY_ADDONS;
  }

  HRESULT WINAPI Initialize(IAIMPCore* core) override {
    Ref<IAIMPServiceMenuManager> menus;
    Ref<IAIMPServiceThreads> threads;
    if (FAILED(core->QueryInterface(IID_IAIMPServiceMenuManager,
                                    menus.putVoid())) ||
        FAILED(core->QueryInterface(IID_IAIMPServiceThreads,
                                    threads.putVoid()))) {
      return E_NOTIMPL;
    }
    g_core = core;
    InterlockedExchange(&g_shutdown, 0);

    Ref<IAIMPMenuItem> parent;
    Ref<IAIMPMenuItem> item;
    Ref<IAIMPString> id;
    Ref<IAIMPString> caption;
    HRESULT hr = E_FAIL;
    if (SUCCEEDED(menus->GetBuiltIn(AIMP_MENUID_PLAYER_PLAYLIST_CONTEXT_FUNCTIONS,
                                    parent.put())) &&
        SUCCEEDED(core->CreateObject(IID_IAIMPMenuItem, item.putVoid())) &&
        MakeString(kMenuId, &id) && MakeString(kCaption, &caption)) {
      TranslateAction* action = new TranslateAction();
      if (SUCCEEDED(item->SetValueAsObject(AIMP_MENUITEM_PROPID_ID, id.get())) &&
          SUCCEEDED(item->SetValueAsObject(AIMP_MENUITEM_PROPID_CAPTION,
                                           caption.get())) &&
          SUCCEEDED(item->SetValueAsObject(AIMP_MENUITEM_PROPID_EVENT, action)) &&
          SUCCEEDED(item->SetValueAsObject(AIMP_MENUITEM_PROPID_PARENT,
                                           parent.get()))) {
        hr = core->RegisterExtension(IID_IAIMPServiceMenuManager, item.get());
      }
      action->Release();
    }
    if (FAILED(hr)) {
      g_core = nullptr;
      return hr;
    }

    core->AddRef();
    threads->AddRef();
    AcquireSRWLockExclusive(&g_lock);
    g_threads = threads.get();
    ReleaseSRWLockExclusive(&g_lock);
    return S_OK;
  }

  HRESULT WINAPI Finalize() override {
    AcquireSRWLockExclusive(&g_lock);
    InterlockedExchange(&g_shutdown, 1);
    IAIMPServiceThreads* threads = g_threads;
    g_threads = nullptr;
    ReleaseSRWLockExclusive(&g_lock);

    // Workers waiting for vot-local.exe keep the DLL pinned and skip AIMP calls once
    // g_shutdown is set; the core is released only when none of them can still use it.
    for (int i = 0; i < 30 && InterlockedCompareExchange(&g_workers, 0, 0) > 0; i++) {
      Sleep(100);
    }
    if (InterlockedCompareExchange(&g_workers, 0, 0) == 0) {
      if (threads) {
        threads->Release();
      }
      if (g_core) {
        g_core->Release();
      }
    }
    g_core = nullptr;
    return S_OK;
  }

  void WINAPI SystemNotification(int, IUnknown*) override {}
};

}  // namespace

extern "C" __declspec(dllexport) HRESULT WINAPI
AIMPPluginGetHeader(IAIMPPlugin** header) {
  if (!header) {
    return E_POINTER;
  }
  *header = new Plugin();
  return S_OK;
}
