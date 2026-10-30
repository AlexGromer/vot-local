// Stand-in for vot-local.exe in the AIMP plugin test: checks the arguments and reports
// <input>.ru.m4a through --result-file, like the real tool does on success.

#include <windows.h>

#include <string>

namespace {

bool WriteUtf8(const std::wstring& path, const std::wstring& text) {
  int len = WideCharToMultiByte(CP_UTF8, 0, text.c_str(),
                                static_cast<int>(text.size()), nullptr, 0,
                                nullptr, nullptr);
  std::string bytes(len, '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()),
                      bytes.data(), len, nullptr, nullptr);
  HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr,
                            CREATE_ALWAYS, 0, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    return false;
  }
  DWORD written = 0;
  BOOL ok = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()),
                      &written, nullptr);
  CloseHandle(file);
  return ok && written == bytes.size();
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc != 7 || std::wstring(argv[1]) != L"--format" ||
      std::wstring(argv[2]) != L"m4a" ||
      std::wstring(argv[3]) != L"--pause-on-error" ||
      std::wstring(argv[4]) != L"--result-file") {
    return 2;
  }
  std::wstring input = argv[6];
  if (input.find(L"slow") != std::wstring::npos) {
    Sleep(3000);
  }
  return WriteUtf8(argv[5], input + L".ru.m4a") ? 0 : 3;
}
