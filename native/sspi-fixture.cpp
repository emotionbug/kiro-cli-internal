// Validation-only Windows SSPI peer. Build outside the distributable bundle.
// It authenticates the current Windows token using the real OS server provider,
// then returns fixed HTTP data or echoes opaque CONNECT bytes; it never routes.
#define NOMINMAX
#define SECURITY_WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <sspi.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cstdio>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

namespace {
std::atomic<bool> stopping{false};
std::atomic<SOCKET> listening{INVALID_SOCKET}, active{INVALID_SOCKET};
void stop() {
    stopping = true;
    SOCKET s = listening.exchange(INVALID_SOCKET); if (s != INVALID_SOCKET) closesocket(s);
    s = active.load(); if (s != INVALID_SOCKET) shutdown(s, SD_BOTH);
}
bool equal(std::string_view a, std::string_view b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) { char c = a[i]; if (c >= 'A' && c <= 'Z') c += 'a' - 'A'; if (c != b[i]) return false; }
    return true;
}
std::string_view trim(std::string_view s) { while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) s.remove_prefix(1); while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) s.remove_suffix(1); return s; }
std::string_view field(std::string_view header, std::string_view name) {
    size_t pos = header.find("\r\n") + 2;
    while (pos < header.size()) { size_t end = header.find("\r\n", pos); if (end == std::string_view::npos || end == pos) break; size_t colon = header.find(':', pos); if (colon < end && equal(header.substr(pos, colon - pos), name)) return trim(header.substr(colon + 1, end - colon - 1)); pos = end + 2; }
    return {};
}
bool sendAll(SOCKET s, const char* data, size_t size) { while (size && !stopping) { int n = send(s, data, static_cast<int>(std::min(size, size_t(16384))), 0); if (n <= 0) return false; data += n; size -= n; } return !size; }
bool sendAll(SOCKET s, const std::string& data) { return sendAll(s, data.data(), data.size()); }
std::string readHeader(SOCKET s) {
    std::string text; text.reserve(4096); std::array<char, 4096> bytes{};
    while (text.size() < 65536) {
        int count = recv(s, bytes.data(), static_cast<int>(std::min(bytes.size(), size_t(65536) - text.size())), MSG_PEEK); if (count <= 0) throw "header";
        size_t tail = std::min(size_t(3), text.size()), take = count; bool done = false;
        auto byte = [&](size_t i) { return i < tail ? text[text.size() - tail + i] : bytes[i - tail]; };
        for (size_t i = 0; i + 3 < tail + static_cast<size_t>(count); ++i) if (byte(i) == '\r' && byte(i + 1) == '\n' && byte(i + 2) == '\r' && byte(i + 3) == '\n') { take = i + 4 - tail; done = true; break; }
        while (take) { int n = recv(s, bytes.data(), static_cast<int>(std::min(take, bytes.size())), 0); if (n <= 0) throw "header"; text.append(bytes.data(), n); take -= n; }
        if (done) return text;
    }
    throw "header-limit";
}
std::string encode(const unsigned char* data, size_t size) {
    constexpr char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result; result.reserve((size + 2) / 3 * 4);
    for (size_t i = 0; i < size; i += 3) { unsigned value = unsigned(data[i]) << 16; if (i + 1 < size) value |= unsigned(data[i + 1]) << 8; if (i + 2 < size) value |= data[i + 2]; result += table[value >> 18]; result += table[(value >> 12) & 63]; result += i + 1 < size ? table[(value >> 6) & 63] : '='; result += i + 2 < size ? table[value & 63] : '='; }
    return result;
}
std::vector<unsigned char> decode(std::string_view text) {
    if (text.size() > 48000) throw "token-limit";
    std::vector<unsigned char> result; result.reserve(text.size() * 3 / 4); unsigned value = 0, bits = 0;
    for (char c : text) { if (c == '=') break; int digit = c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52 : c == '+' ? 62 : c == '/' ? 63 : -1; if (digit < 0) throw "token"; value = (value << 6) | digit; bits += 6; if (bits >= 8) { bits -= 8; result.push_back(static_cast<unsigned char>(value >> bits)); } }
    return result;
}
struct ServerContext {
    CredHandle credential{}; CtxtHandle context{}; bool haveCredential = false, haveContext = false;
    ~ServerContext() { if (haveContext) DeleteSecurityContext(&context); if (haveCredential) FreeCredentialsHandle(&credential); }
    std::pair<bool, std::string> accept(std::string_view input) {
        TimeStamp expiry{};
        if (!haveCredential) { wchar_t package[] = L"Negotiate"; if (AcquireCredentialsHandleW(nullptr, package, SECPKG_CRED_INBOUND, nullptr, nullptr, nullptr, nullptr, &credential, &expiry) != SEC_E_OK) throw "inbound-credentials"; haveCredential = true; }
        auto bytes = decode(input); SecBuffer inBuffer{static_cast<ULONG>(bytes.size()), SECBUFFER_TOKEN, bytes.data()}, outBuffer{0, SECBUFFER_TOKEN, nullptr}; SecBufferDesc in{SECBUFFER_VERSION, 1, &inBuffer}, out{SECBUFFER_VERSION, 1, &outBuffer}; ULONG attributes = 0;
        auto status = AcceptSecurityContext(&credential, haveContext ? &context : nullptr, &in, ASC_REQ_CONNECTION | ASC_REQ_ALLOCATE_MEMORY, SECURITY_NATIVE_DREP, &context, &out, &attributes, &expiry);
        if (status == SEC_I_COMPLETE_NEEDED || status == SEC_I_COMPLETE_AND_CONTINUE) { if (CompleteAuthToken(&context, &out) != SEC_E_OK) { if (outBuffer.pvBuffer) FreeContextBuffer(outBuffer.pvBuffer); throw "inbound-complete"; } }
        if (status != SEC_E_OK && status != SEC_I_CONTINUE_NEEDED && status != SEC_I_COMPLETE_NEEDED && status != SEC_I_COMPLETE_AND_CONTINUE) { if (outBuffer.pvBuffer) FreeContextBuffer(outBuffer.pvBuffer); throw "inbound-rejected"; }
        haveContext = true;
        if (outBuffer.cbBuffer > 32000) { FreeContextBuffer(outBuffer.pvBuffer); throw "out-token-limit"; }
        auto token = encode(static_cast<unsigned char*>(outBuffer.pvBuffer), outBuffer.cbBuffer); if (outBuffer.pvBuffer) FreeContextBuffer(outBuffer.pvBuffer);
        return {status == SEC_E_OK || status == SEC_I_COMPLETE_NEEDED, std::move(token)};
    }
};
void serve(SOCKET s) {
    ServerContext context;
    for (unsigned round = 0; round < 6 && !stopping; ++round) {
        auto request = readHeader(s); auto authorization = field(request, "proxy-authorization");
        if (authorization.empty()) { if (!sendAll(s, "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Negotiate\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n")) return; continue; }
        if (authorization.size() < 10 || !equal(authorization.substr(0, 10), "negotiate ")) throw "wrong-auth-scheme";
        auto result = context.accept(authorization.substr(10));
        std::string authHeader = result.second.empty() ? "" : "Proxy-Authenticate: Negotiate " + result.second + "\r\n";
        if (!result.first) { if (!sendAll(s, "HTTP/1.1 407 Proxy Authentication Required\r\n" + authHeader + "Content-Length: 0\r\nConnection: keep-alive\r\n\r\n")) return; continue; }
        // SEC_E_OK is supplied only by the real OS peer after authenticating the
        // current logon credentials. No synthetic success is emitted on error.
        if (request.rfind("CONNECT ", 0) == 0) {
            if (!sendAll(s, "HTTP/1.1 200 Connection Established\r\n" + authHeader + "\r\n")) return;
            std::array<char, 16384> data{};
            while (!stopping) { int count = recv(s, data.data(), static_cast<int>(data.size()), 0); if (count <= 0) break; if (!sendAll(s, data.data(), count)) break; }
            shutdown(s, SD_SEND); return;
        }
        sendAll(s, "HTTP/1.1 200 OK\r\n" + authHeader + "Content-Length: 9\r\nX-SSPI-Fixture: authenticated\r\nConnection: close\r\n\r\nsspi-http"); return;
    }
    throw "round-limit";
}
} // namespace
int main() {
    WSADATA data{}; if (WSAStartup(MAKEWORD(2, 2), &data)) return 1;
    int result = 0; std::thread owner;
    try {
        listening = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); if (listening == INVALID_SOCKET) throw "socket";
        BOOL exclusive = TRUE; setsockopt(listening, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char*>(&exclusive), sizeof(exclusive));
        sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (bind(listening, reinterpret_cast<sockaddr*>(&address), sizeof(address)) || listen(listening, 4)) throw "listen";
        int size = sizeof(address); if (getsockname(listening, reinterpret_cast<sockaddr*>(&address), &size)) throw "listen";
        owner = std::thread([] { HANDLE input = GetStdHandle(STD_INPUT_HANDLE); std::array<char, 64> buffer{}; while (!stopping) { DWORD available = 0, read = 0; if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) { stop(); return; } if (available && !ReadFile(input, buffer.data(), static_cast<DWORD>(std::min<size_t>(buffer.size(), available)), &read, nullptr)) { stop(); return; } Sleep(50); } });
        std::printf("KIRO_SSPI_FIXTURE_READY %u\n", ntohs(address.sin_port)); std::fflush(stdout);
        while (!stopping) {
            SOCKET s = accept(listening, nullptr, nullptr); if (s == INVALID_SOCKET) break; active = s;
            DWORD timeout = 10000; setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout)); setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout));
            try { serve(s); } catch (...) { result = 1; std::puts("KIRO_SSPI_FIXTURE_ERROR authentication"); std::fflush(stdout); }
            active = INVALID_SOCKET; closesocket(s);
        }
    } catch (...) { result = 1; std::puts("KIRO_SSPI_FIXTURE_ERROR startup"); std::fflush(stdout); }
    stop(); if (owner.joinable()) owner.join(); WSACleanup(); return result;
}
