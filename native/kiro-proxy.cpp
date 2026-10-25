#define NOMINMAX
#define SECURITY_WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <winhttp.h>
#include <sspi.h>
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <optional>
#include <iostream>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

namespace {
constexpr size_t HeaderLimit = 65536, BufferSize = 16384, QueueLimit = 16;
std::atomic<bool> stopping{false};
std::mutex socketsMutex, queueMutex, routeMutex;
std::condition_variable queueReady;
std::vector<SOCKET> sockets;
std::deque<SOCKET> pending;
std::atomic<SOCKET> listener{INVALID_SOCKET};
HINTERNET session = nullptr;
std::string localAuthorization, mode, configuredProxy;
std::wstring pacUrl, systemProxy, bypass;
bool detect = false;
bool asciiEqual(std::string_view a, std::string_view b) noexcept {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) {
        auto x = a[i], y = b[i];
        if (x >= 'A' && x <= 'Z') x += 'a' - 'A';
        if (y >= 'A' && y <= 'Z') y += 'a' - 'A';
        if (x != y) return false;
    }
    return true;
}

std::string lower(std::string s) { for (auto& c : s) if (c >= 'A' && c <= 'Z') c += 'a' - 'A'; return s; }
std::string trim(const std::string& s) { const auto a = s.find_first_not_of(" \t\r\n"); return a == std::string::npos ? "" : s.substr(a, s.find_last_not_of(" \t\r\n") - a + 1); }
std::wstring wide(const std::string& s) {
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), nullptr, 0);
    if (!n && !s.empty()) throw "encoding";
    std::wstring w(n, 0); if (n) MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), w.data(), n); return w;
}
std::string narrow(const std::wstring& s) {
    int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0, nullptr, nullptr);
    std::string out(n, 0); if (n) WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), n, nullptr, nullptr); return out;
}
void track(SOCKET s) { std::lock_guard<std::mutex> lock(socketsMutex); if (stopping) { closesocket(s); throw "shutdown"; } sockets.push_back(s); }
void release(SOCKET s) { if (s == INVALID_SOCKET) return; std::lock_guard<std::mutex> lock(socketsMutex); auto i = std::find(sockets.begin(), sockets.end(), s); if (i != sockets.end()) { closesocket(s); sockets.erase(i); } }
struct Socket { SOCKET s = INVALID_SOCKET; ~Socket() { release(s); } };
void stop() {
    if (stopping.exchange(true)) return;
    { std::lock_guard<std::mutex> lock(socketsMutex); for (auto s : sockets) shutdown(s, SD_BOTH); }
    SOCKET listening = listener.exchange(INVALID_SOCKET); if (listening != INVALID_SOCKET) closesocket(listening);
    queueReady.notify_all();
}
BOOL WINAPI control(DWORD type) { return type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT ? TRUE : FALSE; }
void timeout(SOCKET s) { DWORD ms = 30000; setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<char*>(&ms), sizeof(ms)); setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<char*>(&ms), sizeof(ms)); }
bool sendAll(SOCKET s, const char* data, size_t length) {
    while (length && !stopping) { int n = send(s, data, static_cast<int>(std::min(length, size_t(16384))), 0); if (n <= 0) return false; data += n; length -= n; } return length == 0;
}
bool sendAll(SOCKET s, const std::string& sdata) { return sendAll(s, sdata.data(), sdata.size()); }
void errorResponse(SOCKET s, int status) { const char* reason = status == 407 ? "Proxy Authentication Required" : status == 400 ? "Bad Request" : "Bad Gateway"; std::string h = "HTTP/1.1 " + std::to_string(status) + " " + reason + "\r\nContent-Length: 0\r\nConnection: close\r\n"; if (status == 407) h += "Proxy-Authenticate: Basic realm=\"kiro-private\"\r\n"; sendAll(s, h + "\r\n"); }
std::string base64(const unsigned char* p, size_t n) { static constexpr char chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; std::string out; out.reserve((n + 2) / 3 * 4); for (size_t i = 0; i < n; i += 3) { unsigned v = unsigned(p[i]) << 16; if (i + 1 < n) v |= unsigned(p[i + 1]) << 8; if (i + 2 < n) v |= p[i + 2]; out += chars[(v >> 18) & 63]; out += chars[(v >> 12) & 63]; out += i + 1 < n ? chars[(v >> 6) & 63] : '='; out += i + 2 < n ? chars[v & 63] : '='; } return out; }
std::vector<unsigned char> unbase64(const std::string& s) { if (s.size() > 48000) throw "token-limit"; std::vector<unsigned char> out; out.reserve(s.size() * 3 / 4); unsigned value = 0, bits = 0; for (unsigned char c : s) { if (c == '=') break; int x = c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52 : c == '+' ? 62 : c == '/' ? 63 : -1; if (x < 0) throw "token"; value = (value << 6) | x; bits += 6; if (bits >= 8) { bits -= 8; out.push_back(static_cast<unsigned char>(value >> bits)); } } return out; }
struct Header {
    std::string first;
    std::vector<std::pair<std::string, std::string>> fields;
    const std::string& get(std::string_view name) const { static const std::string empty; for (const auto& p : fields) if (asciiEqual(p.first, name)) return p.second; return empty; }
};
Header parseHeader(const std::string& text) {
    Header h; size_t pos = text.find("\r\n");
    if (pos == std::string::npos) throw "header-format";
    h.first = text.substr(0, pos); pos += 2;
    while (pos + 2 < text.size()) {
        size_t e = text.find("\r\n", pos), colon = text.find(':', pos);
        if (e == pos) break;
        if (e == std::string::npos || colon == std::string::npos || colon >= e || text[pos] == ' ' || text[pos] == '\t' || h.fields.size() == 128) throw "header-format";
        h.fields.emplace_back(text.substr(pos, colon - pos), trim(text.substr(colon + 1, e - colon - 1))); pos = e + 2;
    }
    return h;
}
Header readHeader(SOCKET s) {
    // MSG_PEEK leaves all body/tunnel bytes in the socket: no lost TLS ClientHello.
    std::string text; text.reserve(4096); std::array<char, 4096> buf{};
    while (text.size() < HeaderLimit) {
        int n = recv(s, buf.data(), static_cast<int>(std::min(buf.size(), HeaderLimit - text.size())), MSG_PEEK);
        if (n <= 0) throw "header-read";
        size_t tail = std::min(size_t(3), text.size()), take = static_cast<size_t>(n);
        bool done = false;
        auto byte = [&](size_t i) { return i < tail ? text[text.size() - tail + i] : buf[i - tail]; };
        for (size_t i = 0; i + 3 < tail + static_cast<size_t>(n); ++i) {
            if (byte(i) == '\r' && byte(i + 1) == '\n' && byte(i + 2) == '\r' && byte(i + 3) == '\n') {
                take = i + 4 - tail; done = true; break;
            }
        }
        size_t received = 0;
        while (received < take) { int got = recv(s, buf.data(), static_cast<int>(std::min(buf.size(), take - received)), 0); if (got <= 0) throw "header-read"; text.append(buf.data(), got); received += got; }
        if (!done) continue;
        return parseHeader(text);
    }
    throw "header-limit";
}
struct Endpoint { std::string host; std::string port; };
Endpoint endpoint(std::string authority, const char* defaultPort) {
    Endpoint e;
    if (authority.empty() || authority.find_first_of("@/\\ \t\r\n?#") != std::string::npos) throw "authority";
    if (authority[0] == '[') { size_t close = authority.find(']'); if (close == std::string::npos) throw "authority"; e.host = authority.substr(1, close - 1); if (close + 1 < authority.size()) { if (authority[close + 1] != ':') throw "authority"; e.port = authority.substr(close + 2); } }
    else { size_t colon = authority.find(':'); if (colon != std::string::npos) { e.host = authority.substr(0, colon); e.port = authority.substr(colon + 1); } else e.host = authority; }
    if (e.port.empty()) e.port = defaultPort;
    if (e.host.empty() || e.port.empty() || e.port.size() > 5 || e.port.find_first_not_of("0123456789") != std::string::npos || std::stoul(e.port) == 0 || std::stoul(e.port) > 65535) throw "authority";
    return e;
}
bool loopback(const std::string& host) { auto h = lower(host); if (!h.empty() && h.back() == '.') h.pop_back(); IN_ADDR address{}; return h == "localhost" || (h.size() > 10 && h.compare(h.size() - 10, 10, ".localhost") == 0) || h == "::1" || (InetPtonA(AF_INET, h.c_str(), &address) == 1 && (ntohl(address.s_addr) >> 24) == 127); }
SOCKET connectTo(const Endpoint& e) {
    addrinfo hints{}; hints.ai_socktype = SOCK_STREAM; hints.ai_family = AF_UNSPEC; addrinfo* addresses = nullptr;
    if (getaddrinfo(e.host.c_str(), e.port.c_str(), &hints, &addresses)) throw "dns";
    SOCKET result = INVALID_SOCKET;
    for (auto p = addresses; p && !stopping; p = p->ai_next) {
        SOCKET s = socket(p->ai_family, p->ai_socktype, p->ai_protocol); if (s == INVALID_SOCKET) continue;
        try { track(s); } catch (...) { freeaddrinfo(addresses); throw; }
        u_long nonblock = 1; ioctlsocket(s, FIONBIO, &nonblock);
        int rc = connect(s, p->ai_addr, static_cast<int>(p->ai_addrlen));
        if (rc != 0 && WSAGetLastError() == WSAEWOULDBLOCK) { fd_set writes, errors; FD_ZERO(&writes); FD_ZERO(&errors); FD_SET(s, &writes); FD_SET(s, &errors); timeval wait{10, 0}; rc = select(0, nullptr, &writes, &errors, &wait); int err = 0, len = sizeof(err); if (rc > 0) getsockopt(s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&err), &len); rc = rc > 0 && !err && !FD_ISSET(s, &errors) ? 0 : -1; }
        if (rc == 0) { nonblock = 0; ioctlsocket(s, FIONBIO, &nonblock); timeout(s); result = s; break; }
        release(s);
    }
    freeaddrinfo(addresses); if (result == INVALID_SOCKET) throw "connect"; return result;
}
struct RouteEntry { std::wstring url; std::string proxy; ULONGLONG expiry; };
std::deque<RouteEntry> routes;
bool wildcard(const std::string& text, const std::string& pattern) { size_t t = 0, p = 0, star = std::string::npos, back = 0; while (t < text.size()) { if (p < pattern.size() && (pattern[p] == '?' || pattern[p] == text[t])) { ++t; ++p; } else if (p < pattern.size() && pattern[p] == '*') { star = p++; back = t; } else if (star != std::string::npos) { p = star + 1; t = ++back; } else return false; } while (p < pattern.size() && pattern[p] == '*') ++p; return p == pattern.size(); }
bool bypassed(const std::string& host) { std::string list = lower(narrow(bypass)), h = lower(host); size_t pos = 0; while (pos < list.size()) { size_t end = list.find(';', pos); auto pattern = trim(list.substr(pos, end == std::string::npos ? end : end - pos)); if ((pattern == "<local>" && h.find('.') == std::string::npos && h.find(':') == std::string::npos) || (!pattern.empty() && wildcard(h, pattern))) return true; if (end == std::string::npos) break; pos = end + 1; } return false; }
std::string selectProxy(const std::wstring& raw, bool secure) {
    std::string list = narrow(raw), generic, specific; size_t pos = 0;
    while (pos < list.size()) { size_t end = list.find(';', pos); auto part = trim(list.substr(pos, end == std::string::npos ? end : end - pos)); size_t eq = part.find('='); if (eq != std::string::npos) { if (lower(part.substr(0, eq)) == (secure ? "https" : "http")) specific = part.substr(eq + 1); } else if (generic.empty()) generic = part; if (end == std::string::npos) break; pos = end + 1; }
    auto selected = specific.empty() ? generic : specific; size_t space = selected.find_first_of(" \t"); if (space != std::string::npos) selected.resize(space);
    if (selected.rfind("http://", 0) == 0) selected.erase(0, 7);
    if (selected.empty()) throw "proxy-format"; endpoint(selected, "80"); return selected;
}
std::string route(const std::string& url, const Endpoint& target, bool secure) {
    if (loopback(target.host)) return "";
    if (!configuredProxy.empty()) return configuredProxy;
    if (pacUrl.empty() && !detect) { if (systemProxy.empty() || bypassed(target.host)) return ""; return selectProxy(systemProxy, secure); }
    auto wurl = wide(url); std::lock_guard<std::mutex> lock(routeMutex);
    auto now = GetTickCount64(); for (auto& cached : routes) if (cached.url == wurl && cached.expiry > now) return cached.proxy;
    WINHTTP_AUTOPROXY_OPTIONS options{};
    if (!pacUrl.empty()) { options.dwFlags = WINHTTP_AUTOPROXY_CONFIG_URL; options.lpszAutoConfigUrl = pacUrl.c_str(); }
    else { options.dwFlags = WINHTTP_AUTOPROXY_AUTO_DETECT; options.dwAutoDetectFlags = WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A; }
    // Never send current-user credentials to an arbitrary PAC download host.
    options.fAutoLogonIfChallenged = FALSE;
    WINHTTP_PROXY_INFO info{};
    if (!WinHttpGetProxyForUrl(session, wurl.c_str(), &options, &info)) {
        // WPAD reporting no discoverable PAC is absence, not a script/download
        // failure. An explicitly configured PAC never receives this fallback.
        if (pacUrl.empty() && GetLastError() == ERROR_WINHTTP_AUTODETECTION_FAILED) {
            return systemProxy.empty() || bypassed(target.host) ? "" : selectProxy(systemProxy, secure);
        }
        throw "pac-lookup";
    }
    std::string selected;
    try { if (info.dwAccessType == WINHTTP_ACCESS_TYPE_NAMED_PROXY) { if (!info.lpszProxy) throw "pac-empty"; selected = selectProxy(info.lpszProxy, secure); } else if (info.dwAccessType != WINHTTP_ACCESS_TYPE_NO_PROXY) throw "pac-result"; }
    catch (...) { GlobalFree(info.lpszProxy); GlobalFree(info.lpszProxyBypass); throw; }
    GlobalFree(info.lpszProxy); GlobalFree(info.lpszProxyBypass);
    if (routes.size() == 32) routes.pop_front(); routes.push_back({std::move(wurl), selected, now + 60000}); return selected;
}
struct Auth {
    CredHandle credentials{}; CtxtHandle context{}; bool haveCredentials = false, haveContext = false, complete = false; std::string scheme;
    ~Auth() { if (haveContext) DeleteSecurityContext(&context); if (haveCredentials) FreeCredentialsHandle(&credentials); }
    std::string next(const Header& h, const Endpoint& proxy) {
        std::string challenge, selected;
        for (const auto& p : h.fields) {
            if (lower(p.first) != "proxy-authenticate") continue;
            size_t start = 0;
            while (start < p.second.size()) {
                size_t comma = p.second.find(',', start);
                auto value = trim(p.second.substr(start, comma == std::string::npos ? comma : comma - start)), low = lower(value);
                if ((low == "negotiate" || low.rfind("negotiate ", 0) == 0) && (scheme.empty() || scheme == "Negotiate")) { selected = "Negotiate"; challenge = trim(value.substr(9)); }
                else if ((low == "ntlm" || low.rfind("ntlm ", 0) == 0) && (scheme.empty() || scheme == "NTLM") && selected.empty()) { selected = "NTLM"; challenge = trim(value.substr(4)); }
                if (comma == std::string::npos) break;
                start = comma + 1;
            }
        }
        if (selected.empty()) throw "auth-scheme";
        scheme = selected;
        TimeStamp expiry{};
        if (!haveCredentials) { auto package = wide(scheme); if (AcquireCredentialsHandleW(nullptr, package.data(), SECPKG_CRED_OUTBOUND, nullptr, nullptr, nullptr, nullptr, &credentials, &expiry) != SEC_E_OK) throw "credentials"; haveCredentials = true; }
        auto input = unbase64(challenge); SecBuffer inBuffer{static_cast<ULONG>(input.size()), SECBUFFER_TOKEN, input.data()}, outBuffer{0, SECBUFFER_TOKEN, nullptr}; SecBufferDesc in{SECBUFFER_VERSION, 1, &inBuffer}, out{SECBUFFER_VERSION, 1, &outBuffer}; ULONG attributes = 0; auto spn = wide("HTTP/" + proxy.host);
        auto status = InitializeSecurityContextW(&credentials, haveContext ? &context : nullptr, spn.data(), ISC_REQ_CONNECTION | ISC_REQ_ALLOCATE_MEMORY, 0, SECURITY_NATIVE_DREP, input.empty() ? nullptr : &in, 0, &context, &out, &attributes, &expiry);
        if (status == SEC_I_COMPLETE_NEEDED || status == SEC_I_COMPLETE_AND_CONTINUE) { if (CompleteAuthToken(&context, &out) != SEC_E_OK) { if (outBuffer.pvBuffer) FreeContextBuffer(outBuffer.pvBuffer); throw "auth-complete"; } }
        if (status != SEC_E_OK && status != SEC_I_CONTINUE_NEEDED && status != SEC_I_COMPLETE_NEEDED && status != SEC_I_COMPLETE_AND_CONTINUE) { if (outBuffer.pvBuffer) FreeContextBuffer(outBuffer.pvBuffer); throw "auth-rejected"; }
        haveContext = true;
        complete = status == SEC_E_OK || status == SEC_I_COMPLETE_NEEDED;
        if (outBuffer.cbBuffer > 32000) { FreeContextBuffer(outBuffer.pvBuffer); throw "token-limit"; }
        auto value = scheme + " " + base64(static_cast<unsigned char*>(outBuffer.pvBuffer), outBuffer.cbBuffer); FreeContextBuffer(outBuffer.pvBuffer); return value;
    }
    void finish(const Header& h, const Endpoint& proxy) {
        if (!haveContext || complete) return;
        auto token = next(h, proxy);
        if (!complete || token.size() != scheme.size() + 1) throw "auth-incomplete";
    }
};
int status(const Header& h) { if (h.first.rfind("HTTP/1.", 0) || h.first.size() < 12) throw "response"; return std::stoi(h.first.substr(9, 3)); }
void drainChallenge(SOCKET s, const Header& h) {
    std::array<char, 4096> buffer{};
    auto drain = [&](size_t size) { while (size) { int n = recv(s, buffer.data(), static_cast<int>(std::min(size, buffer.size())), 0); if (n <= 0) throw "auth-body"; size -= n; } };
    auto line = [&]() { std::string value; while (value.size() < 4096) { char c; if (recv(s, &c, 1, 0) != 1) throw "auth-body"; value += c; if (value.size() >= 2 && value.compare(value.size() - 2, 2, "\r\n") == 0) { value.resize(value.size() - 2); return value; } } throw "auth-body-limit"; };
    auto encoding = lower(h.get("transfer-encoding"));
    if (!encoding.empty()) {
        if (encoding != "chunked" || !h.get("content-length").empty()) throw "auth-framing";
        size_t total = 0;
        for (unsigned chunks = 0; chunks < 1024; ++chunks) {
            auto sizeLine = line(); auto ext = sizeLine.find(';'); auto number = sizeLine.substr(0, ext); size_t used = 0, size = 0;
            try { size = std::stoul(number, &used, 16); } catch (...) { throw "auth-framing"; }
            if (used != number.size() || total + size > HeaderLimit) throw "auth-body-limit";
            total += size;
            if (!size) { for (unsigned trailers = 0; trailers < 32; ++trailers) if (line().empty()) return; throw "auth-body-limit"; }
            drain(size); if (!line().empty()) throw "auth-framing";
        }
        throw "auth-body-limit";
    }
    auto cl = h.get("content-length"); if (cl.empty()) throw "auth-unframed";
    size_t size = 0; try { size_t used = 0; size = std::stoul(cl, &used); if (used != cl.size()) throw "auth-body"; } catch (...) { throw "auth-body"; }
    if (size > HeaderLimit) throw "auth-body-limit"; drain(size);
}
std::string responseHeader(const Header& h, bool close = false) {
    std::string out = h.first + "\r\n";
    for (const auto& p : h.fields) {
        auto name = lower(p.first);
        if (name != "proxy-authenticate" && name != "proxy-authorization" && (!close || name != "connection")) out += p.first + ": " + p.second + "\r\n";
    }
    if (close) out += "Connection: close\r\n";
    return out + "\r\n";
}
// Only the first authenticated HTTP request belongs to this connection. Bound
// body framing prevents a pipelined second Proxy-Authorization leaking upstream.
struct BodyFrame {
    enum class State { Done, Fixed, ChunkSize, ChunkData, ChunkEnd, Trailers, UntilEOF };
    State state = State::Done;
    unsigned long long remaining = 0;
    size_t trailerBytes = 0;
    std::string line;
    explicit BodyFrame(const Header& h, bool response = false) {
        unsigned lengths = 0, encodings = 0;
        for (const auto& field : h.fields) { auto name = lower(field.first); if (name == "content-length") ++lengths; if (name == "transfer-encoding") ++encodings; }
        if (lengths > 1 || encodings > 1 || lengths && encodings) throw "request-framing";
        auto encoding = lower(h.get("transfer-encoding"));
        if (!encoding.empty()) {
            if (encoding == "chunked" || response && encoding.size() > 9 && encoding.compare(encoding.size() - 9, 9, ", chunked") == 0) { state = State::ChunkSize; line.reserve(128); }
            else if (response) state = State::UntilEOF;
            else throw "request-encoding";
        }
        else if (lengths) {
            const auto value = h.get("content-length");
            if (value.empty() || value.find_first_not_of("0123456789") != std::string::npos) throw "request-length";
            size_t used = 0; remaining = std::stoull(value, &used); if (used != value.size()) throw "request-length";
            if (remaining) state = State::Fixed;
        }
        else if (response) state = State::UntilEOF;
    }
    bool done() const { return state == State::Done; }
    size_t limit(size_t space) const {
        if (state == State::UntilEOF) return space;
        if (state == State::Fixed || state == State::ChunkData) return static_cast<size_t>(std::min<unsigned long long>(space, remaining));
        return done() ? 0 : 1;
    }
    void consume(const char* data, size_t size) {
        if (state == State::UntilEOF) return;
        if (state == State::Fixed || state == State::ChunkData) {
            remaining -= size;
            if (!remaining) { if (state == State::Fixed) state = State::Done; else { state = State::ChunkEnd; line.clear(); } }
            return;
        }
        line.append(data, size);
        if (line.size() > 4096) throw "request-chunk-line";
        if (state == State::ChunkEnd) {
            if (line.size() == 1 && line[0] != '\r' || line.size() == 2 && line != "\r\n") throw "request-chunk-end";
            if (line.size() == 2) { line.clear(); state = State::ChunkSize; }
            return;
        }
        if (line.size() < 2 || line.compare(line.size() - 2, 2, "\r\n")) return;
        if (state == State::Trailers) {
            trailerBytes += line.size(); if (trailerBytes > 16384) throw "request-trailers";
            if (line.size() == 2) state = State::Done;
        } else {
            auto number = line.substr(0, line.find(';')); number = trim(number);
            if (number.empty() || number.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos) throw "request-chunk-size";
            size_t used = 0; remaining = std::stoull(number, &used, 16); if (used != number.size()) throw "request-chunk-size";
            state = remaining ? State::ChunkData : State::Trailers;
        }
        line.clear();
    }
};
// Response headers and framing are inspected without buffering response bodies.
// This also finishes ordinary keep-alive proxy responses without waiting for an
// upstream EOF, leaving SSPI handshakes on a genuinely persistent connection.
struct ResponseFrame {
    bool headRequest;
    unsigned interim = 0;
    std::string header;
    std::optional<BodyFrame> body;
    explicit ResponseFrame(bool head) : headRequest(head) { header.reserve(4096); }
    ResponseFrame(const Header& h, bool head) : ResponseFrame(head) { setBody(h); }
    void setBody(const Header& h) {
        int code = status(h);
        if (code < 200) {
            if (++interim > 8) throw "interim-limit";
            header.clear(); return;
        }
        if (headRequest || code == 204 || code == 304) body.emplace(Header{});
        else body.emplace(h, true);
    }
    bool done() const { return body && body->done(); }
    size_t consume(const char* data, size_t size) {
        size_t used = 0;
        while (used < size && !done()) {
            if (!body) {
                header += data[used++];
                if (header.size() > HeaderLimit) throw "response-header-limit";
                if (header.size() >= 4 && header.compare(header.size() - 4, 4, "\r\n\r\n") == 0) {
                    auto parsed = parseHeader(header); setBody(parsed); header.clear();
                }
            } else {
                size_t count = body->limit(size - used);
                body->consume(data + used, count); used += count;
            }
        }
        return used;
    }
};
void duplex(SOCKET client, SOCKET upstream, BodyFrame* body = nullptr, ResponseFrame* response = nullptr) {
    struct Flow { SOCKET from, to; std::array<char, BufferSize> bytes{}; size_t begin = 0, end = 0; bool eof = false, shut = false; };
    std::array<Flow, 2> flows{{{client, upstream}, {upstream, client}}};
    flows[0].eof = body && body->done();
    flows[1].eof = response && response->done();
    u_long nonblock = 1; ioctlsocket(client, FIONBIO, &nonblock); ioctlsocket(upstream, FIONBIO, &nonblock);
    auto active = GetTickCount64();
    while (!stopping) {
        fd_set reads, writes; FD_ZERO(&reads); FD_ZERO(&writes); bool finished = true;
        for (auto& f : flows) { if (!f.eof || f.begin < f.end) finished = false; if (!f.eof && f.end < f.bytes.size()) FD_SET(f.from, &reads); if (f.begin < f.end) FD_SET(f.to, &writes); else if (f.eof && !f.shut) { shutdown(f.to, SD_SEND); f.shut = true; } }
        if (finished) return; timeval wait{1, 0}; int rc = select(0, &reads, &writes, nullptr, &wait); if (rc < 0 || GetTickCount64() - active > 600000) return;
        for (auto& f : flows) {
            if (FD_ISSET(f.to, &writes)) { int n = send(f.to, f.bytes.data() + f.begin, static_cast<int>(f.end - f.begin), 0); if (n > 0) { f.begin += n; active = GetTickCount64(); if (f.begin == f.end) f.begin = f.end = 0; } else if (WSAGetLastError() != WSAEWOULDBLOCK) return; }
            if (FD_ISSET(f.from, &reads)) {
                size_t room = f.bytes.size() - f.end;
                if (body && f.from == client) room = body->limit(room);
                int n = recv(f.from, f.bytes.data() + f.end, static_cast<int>(room), 0);
                if (n > 0) {
                    if (body && f.from == client) { body->consume(f.bytes.data() + f.end, n); if (body->done()) f.eof = true; }
                    if (response && f.from == upstream) {
                        n = static_cast<int>(response->consume(f.bytes.data() + f.end, n));
                        if (response->done()) { f.eof = true; flows[0].eof = true; flows[0].begin = flows[0].end = 0; }
                    }
                    f.end += n; active = GetTickCount64();
                } else if (n == 0) f.eof = true;
                else if (WSAGetLastError() != WSAEWOULDBLOCK) return;
            }
        }
    }
}
void serve(SOCKET client) {
    Socket owner{client}; bool replied = false;
    try {
        timeout(client); auto request = readHeader(client);
        const auto& expected = localAuthorization;
        const auto& provided = request.get("proxy-authorization"); unsigned different = static_cast<unsigned>(provided.size() ^ expected.size()); for (size_t i = 0; i < expected.size(); ++i) different |= static_cast<unsigned char>(expected[i]) ^ static_cast<unsigned char>(i < provided.size() ? provided[i] : 0);
        if (different) { errorResponse(client, 407); return; }
        size_t a = request.first.find(' '), b = request.first.find(' ', a == std::string::npos ? 0 : a + 1); if (a == std::string::npos || b == std::string::npos || request.first.substr(b + 1) != "HTTP/1.1") throw "request";
        auto method = request.first.substr(0, a), destination = request.first.substr(a + 1, b - a - 1); bool tunnel = method == "CONNECT";
        std::string authority, path, url; Endpoint target;
        if (tunnel) { authority = destination; target = endpoint(authority, "443"); url = "https://" + authority + "/"; }
        else { if (destination.rfind("http://", 0) != 0) throw "absolute-http-required"; auto slash = destination.find('/', 7); authority = destination.substr(7, slash == std::string::npos ? slash : slash - 7); path = slash == std::string::npos ? "/" : destination.substr(slash); target = endpoint(authority, "80"); url = destination; }
        if (url.size() > 8192) throw "url-limit";
        auto proxyName = route(url, target, tunnel); bool throughProxy = !proxyName.empty(); Endpoint upstreamTarget = throughProxy ? endpoint(proxyName, "80") : target; Socket upstream{connectTo(upstreamTarget)};
        if (tunnel && !throughProxy) { if (!sendAll(client, "HTTP/1.1 200 Connection Established\r\n\r\n")) return; replied = true; duplex(client, upstream.s); return; }
        BodyFrame bodyFrame(request);
        const bool body = !tunnel && !bodyFrame.done();
        bool expect = body && throughProxy;
        bool upgrade = !request.get("upgrade").empty();
        auto makeRequest = [&](const std::string& authorization) {
            std::string out = method + " " + (tunnel ? authority : throughProxy ? destination : path) + " HTTP/1.1\r\n";
            for (const auto& p : request.fields) { auto name = lower(p.first); if (name == "proxy-authorization" || name == "proxy-connection" || name == "connection" || name == "expect" || name == "host") continue; out += p.first + ": " + p.second + "\r\n"; }
            out += "Host: " + authority + "\r\n";
            if (!authorization.empty()) out += "Proxy-Authorization: " + authorization + "\r\n";
            if (expect) out += "Expect: 100-continue\r\n";
            if (tunnel) out += "Proxy-Connection: Keep-Alive\r\n";
            else {
                out += upgrade ? "Connection: Upgrade\r\n" : throughProxy ? "Connection: Keep-Alive\r\n" : "Connection: close\r\n";
                if (throughProxy) out += "Proxy-Connection: Keep-Alive\r\n";
            }
            return out + "\r\n";
        };
        if (!throughProxy) {
            if (!sendAll(upstream.s, makeRequest(""))) throw "send";
            if (lower(request.get("expect")) == "100-continue") sendAll(client, "HTTP/1.1 100 Continue\r\n\r\n");
            if (upgrade) {
                auto response = readHeader(upstream.s); auto code = status(response);
                sendAll(client, responseHeader(response, code != 101)); replied = true;
                BodyFrame noBody(Header{}); ResponseFrame framed(response, method == "HEAD");
                duplex(client, upstream.s, code == 101 ? nullptr : &noBody, code == 101 ? nullptr : &framed);
            } else { replied = true; ResponseFrame framed(method == "HEAD"); duplex(client, upstream.s, &bodyFrame, &framed); }
            return;
        }
        Auth auth; std::string authorization;
        for (unsigned round = 0; round != 6; ++round) {
            if (!sendAll(upstream.s, makeRequest(authorization))) throw "send";
            auto response = readHeader(upstream.s); int code = status(response);
            for (unsigned interim = 0; code > 100 && code < 200 && code != 101; ++interim) {
                if (interim == 8) throw "interim-limit";
                sendAll(client, responseHeader(response)); response = readHeader(upstream.s); code = status(response);
            }
            if (code == 407) {
                bool closed = lower(response.get("connection")) == "close" || lower(response.get("proxy-connection")) == "close";
                // A proxy may close its initial anonymous challenge. Once a
                // context exists, reconnecting would break connection-bound SSPI.
                if (closed && auth.haveContext) throw "auth-connection-close";
                if (!closed) drainChallenge(upstream.s, response);
                authorization = auth.next(response, upstreamTarget);
                if (closed) { release(upstream.s); upstream.s = INVALID_SOCKET; upstream.s = connectTo(upstreamTarget); }
                continue;
            }
            if (code >= 100 && code < 400) auth.finish(response, upstreamTarget);
            if (tunnel) {
                if (code != 200) {
                    sendAll(client, responseHeader(response, true)); replied = true;
                    BodyFrame noBody(Header{}); ResponseFrame framed(response, false); duplex(client, upstream.s, &noBody, &framed); return;
                }
                sendAll(client, "HTTP/1.1 200 Connection Established\r\n\r\n"); replied = true; duplex(client, upstream.s); return;
            }
            if (code == 100) {
                if (lower(request.get("expect")) == "100-continue") sendAll(client, responseHeader(response));
                replied = true; ResponseFrame framed(method == "HEAD"); duplex(client, upstream.s, &bodyFrame, &framed); return;
            }
            sendAll(client, responseHeader(response, code != 101)); replied = true;
            BodyFrame noBody(Header{}); ResponseFrame framed(response, method == "HEAD");
            duplex(client, upstream.s, code == 101 ? nullptr : &noBody, code == 101 ? nullptr : &framed); return;
        }
        throw "auth-rounds";
    } catch (...) { if (!replied && !stopping) errorResponse(client, 502); }
}
void worker() { while (!stopping) { SOCKET s; { std::unique_lock<std::mutex> lock(queueMutex); queueReady.wait(lock, [] { return stopping || !pending.empty(); }); if (stopping) return; s = pending.front(); pending.pop_front(); } serve(s); } }
std::string configLine() { std::string s; for (size_t i = 0; i <= 8192; ++i) { int c = std::cin.get(); if (c == '\n') { if (!s.empty() && s.back() == '\r') s.pop_back(); return s; } if (c == EOF || c == 0 || c < 32 && c != '\r') throw "config"; s += static_cast<char>(c); } throw "config-limit"; }
void loadSystem() {
    WINHTTP_CURRENT_USER_IE_PROXY_CONFIG config{};
    if (!WinHttpGetIEProxyConfigForCurrentUser(&config)) {
        if (GetLastError() != ERROR_FILE_NOT_FOUND) throw "system-config";
    } else {
        if (config.lpszAutoConfigUrl) pacUrl = config.lpszAutoConfigUrl;
        if (config.lpszProxy) systemProxy = config.lpszProxy;
        if (config.lpszProxyBypass) bypass = config.lpszProxyBypass;
        detect = config.fAutoDetect != FALSE;
        GlobalFree(config.lpszAutoConfigUrl); GlobalFree(config.lpszProxy); GlobalFree(config.lpszProxyBypass);
    }
    if (pacUrl.empty() && systemProxy.empty() && !detect) {
        WINHTTP_PROXY_INFO defaults{};
        if (!WinHttpGetDefaultProxyConfiguration(&defaults)) throw "system-default";
        if (defaults.lpszProxy) systemProxy = defaults.lpszProxy;
        if (defaults.lpszProxyBypass) bypass = defaults.lpszProxyBypass;
        GlobalFree(defaults.lpszProxy); GlobalFree(defaults.lpszProxyBypass);
    }
}
} // namespace

int main(int argc, char** argv) {
    if (argc == 2 && std::string(argv[1]) == "--version") { std::puts("kiro-proxy 1 winhttp-sspi workers=8 queue=16 buffer=16384 routes=32"); return 0; }
    WSADATA data{}; if (WSAStartup(MAKEWORD(2, 2), &data)) return 1;
    std::vector<std::thread> workers; std::thread input; int result = 0;
    try {
        if (configLine() != "KIRO_PROXY_V1") throw "protocol";
        auto nonce = configLine(); if (nonce.size() != 64 || nonce.find_first_not_of("0123456789abcdef") != std::string::npos) throw "nonce";
        nonce = "kiro:" + nonce;
        localAuthorization = "Basic " + base64(reinterpret_cast<const unsigned char*>(nonce.data()), nonce.size());
        SecureZeroMemory(nonce.data(), nonce.size()); nonce.clear();
        mode = configLine(); configuredProxy = configLine(); pacUrl = wide(configLine());
        if (mode != "system" && mode != "manual" || !configuredProxy.empty() && !pacUrl.empty() || mode == "manual" && configuredProxy.empty() && pacUrl.empty()) throw "config";
        if (!configuredProxy.empty()) endpoint(configuredProxy, "80");
        if (!pacUrl.empty() && pacUrl.rfind(L"http://", 0) != 0 && pacUrl.rfind(L"https://", 0) != 0) throw "pac-url";
        SetConsoleCtrlHandler(control, TRUE);
        session = WinHttpOpen(L"KiroPrivateProxy/1", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0); if (!session) throw "winhttp";
        if (!WinHttpSetTimeouts(session, 5000, 10000, 10000, 10000)) throw "winhttp-timeouts";
        if (mode == "system" && configuredProxy.empty() && pacUrl.empty()) loadSystem();
        // Resolve once before readiness to surface invalid explicit PAC configuration.
        input = std::thread([] {
            HANDLE pipe = GetStdHandle(STD_INPUT_HANDLE);
            std::array<char, 64> ignored{};
            while (!stopping) {
                DWORD available = 0, read = 0;
                if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr)) { stop(); return; }
                if (available && !ReadFile(pipe, ignored.data(), static_cast<DWORD>(std::min<size_t>(ignored.size(), available)), &read, nullptr)) { stop(); return; }
                Sleep(50);
            }
        });
        if (!pacUrl.empty()) route("https://kiro-proxy-startup.invalid/", {"kiro-proxy-startup.invalid", "443"}, true);
        listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); if (listener == INVALID_SOCKET) throw "listen";
        BOOL exclusive = TRUE; setsockopt(listener, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<char*>(&exclusive), sizeof(exclusive)); sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) || listen(listener, 16)) throw "listen";
        int length = sizeof(address); if (getsockname(listener, reinterpret_cast<sockaddr*>(&address), &length)) throw "listen";
        for (int i = 0; i != 8; ++i) workers.emplace_back(worker);
        if (stopping) throw "shutdown";
        std::printf("KIRO_PROXY_READY %u\n", ntohs(address.sin_port)); std::fflush(stdout);
        while (!stopping) { SOCKET s = accept(listener, nullptr, nullptr); if (s == INVALID_SOCKET) break; track(s); { std::lock_guard<std::mutex> lock(queueMutex); if (pending.size() == QueueLimit) release(s); else { pending.push_back(s); queueReady.notify_one(); } } }
    } catch (const char* reason) { if (!stopping) { result = 1; std::printf("KIRO_PROXY_ERROR %s\n", reason); std::fflush(stdout); } }
    catch (...) { if (!stopping) { result = 1; std::puts("KIRO_PROXY_ERROR internal"); std::fflush(stdout); } }
    stop();
    if (input.joinable()) input.join();
    for (auto& w : workers) if (w.joinable()) w.join();
    { std::lock_guard<std::mutex> lock(socketsMutex); for (auto s : sockets) closesocket(s); sockets.clear(); }
    if (session) WinHttpCloseHandle(session); WSACleanup(); return result;
}
