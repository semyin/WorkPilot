/* WorkPilot's Git-for-Windows path compatibility patch, GPL-2.0-only.
 * This changes path spelling only. The process remains in its AppContainer;
 * CreateFileW and every subsequent access still enforce the Windows ACL.
 * The host supplies drive-to-device names, never open privileged handles.
 */
#include <windows.h>
#include <wchar.h>

int workpilot_is_appcontainer(void)
{
    DWORD value = 0, returned = 0;
    return GetTokenInformation((HANDLE)(LONG_PTR)-4, TokenIsAppContainer,
        &value, sizeof(value), &returned) && value;
}

DWORD workpilot_final_path(HANDLE file, LPWSTR buffer, DWORD capacity, DWORD flags)
{
    DWORD result = GetFinalPathNameByHandleW(file, buffer, capacity, flags);
    DWORD original_error = GetLastError();
    WCHAR mapping[4096], nt_path[32768];
    DWORD mapping_length, nt_length;
    WCHAR *entry;

    if (result || flags != 0 || original_error != ERROR_ACCESS_DENIED)
        return result;
    if (!workpilot_is_appcontainer())
        goto unavailable;
    mapping_length = GetEnvironmentVariableW(L"WORKPILOT_GIT_DEVICE_MAP", mapping,
        sizeof(mapping) / sizeof(mapping[0]));
    if (!mapping_length || mapping_length >= sizeof(mapping) / sizeof(mapping[0]))
        goto unavailable;
    nt_length = GetFinalPathNameByHandleW(file, nt_path,
        sizeof(nt_path) / sizeof(nt_path[0]), VOLUME_NAME_NT);
    if (!nt_length || nt_length >= sizeof(nt_path) / sizeof(nt_path[0]))
        goto unavailable;
    for (entry = mapping; entry && *entry;) {
        WCHAR *end = wcschr(entry, L'|');
        size_t device_length;
        if (end) *end = 0;
        if (entry[0] >= L'A' && entry[0] <= L'Z' && entry[1] == L':' &&
            entry[2] == L'=' && !wcsncmp(entry + 3, L"\\Device\\", 8)) {
            device_length = wcslen(entry + 3);
            if (!_wcsnicmp(nt_path, entry + 3, device_length) &&
                nt_path[device_length] == L'\\') {
                DWORD needed = 6 + nt_length - (DWORD)device_length;
                if (capacity <= needed) return needed + 1;
                memcpy(buffer, L"\\\\?\\", 4 * sizeof(WCHAR));
                buffer[4] = entry[0];
                buffer[5] = L':';
                memcpy(buffer + 6, nt_path + device_length,
                    (nt_length - device_length + 1) * sizeof(WCHAR));
                return needed;
            }
        }
        entry = end ? end + 1 : NULL;
    }
unavailable:
    SetLastError(original_error);
    return 0;
}
