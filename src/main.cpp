// Native entry point for Formula Lab. It serves the existing browser simulator
// directly; Node.js and third-party C++ libraries are not required at runtime.
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#else
#include <arpa/inet.h>
#include <cerrno>
#include <csignal>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#endif

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace fs = std::filesystem;

namespace {
#ifdef _WIN32
using SocketHandle = SOCKET;
constexpr SocketHandle invalid_socket = INVALID_SOCKET;
using SocketLength = int;
int socket_error() { return WSAGetLastError(); }
void close_socket(SocketHandle socket) { closesocket(socket); }
class SocketRuntime {
public:
    SocketRuntime() {
        WSADATA data{};
        const int result = WSAStartup(MAKEWORD(2, 2), &data);
        if (result != 0) throw std::runtime_error("WSAStartup failed: " + std::to_string(result));
    }
    ~SocketRuntime() { WSACleanup(); }
};
#else
using SocketHandle = int;
constexpr SocketHandle invalid_socket = -1;
using SocketLength = socklen_t;
int socket_error() { return errno; }
void close_socket(SocketHandle socket) { ::close(socket); }
class SocketRuntime {
public:
    SocketRuntime() { std::signal(SIGPIPE, SIG_IGN); }
};
#endif

class Socket {
public:
    explicit Socket(SocketHandle handle) : handle_(handle) {}
    ~Socket() { if (handle_ != invalid_socket) close_socket(handle_); }
    Socket(const Socket&) = delete;
    Socket& operator=(const Socket&) = delete;
    Socket(Socket&& other) noexcept : handle_(std::exchange(other.handle_, invalid_socket)) {}
    SocketHandle get() const { return handle_; }
private:
    SocketHandle handle_;
};

[[noreturn]] void network_error(const std::string& operation) {
    throw std::runtime_error(operation + " failed (socket error " + std::to_string(socket_error()) + ").");
}

bool regular_file(const fs::path& path) {
    std::error_code error;
    return fs::is_regular_file(path, error);
}

std::optional<fs::path> executable_path(const char* argument) {
#ifdef _WIN32
    std::vector<wchar_t> buffer(32768);
    const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length != 0 && length < buffer.size()) return fs::path(std::wstring(buffer.data(), length));
#elif defined(__linux__)
    std::error_code error;
    const auto path = fs::read_symlink("/proc/self/exe", error);
    if (!error) return path;
#endif
    std::error_code error_fallback;
    auto path_fallback = fs::absolute(fs::path(argument), error_fallback);
    if (!error_fallback) return path_fallback;
    return std::nullopt;
}

fs::path project_root(const std::optional<fs::path>& requested, const char* executable) {
    std::vector<fs::path> candidates;
    if (requested) candidates.push_back(*requested);
    else {
        std::error_code error;
        auto current = fs::current_path(error);
        if (!error) candidates.push_back(current);
        if (const auto path = executable_path(executable)) {
            // Multi-configuration generators place Windows executables under
            // build/Release or build/Debug. Search ancestors so relocating the
            // whole checkout does not depend on the old compiled source path.
            auto directory = path->parent_path();
            for (int depth = 0; depth < 4 && !directory.empty(); ++depth) {
                candidates.push_back(directory);
                const auto parent = directory.parent_path();
                if (parent == directory) break;
                directory = parent;
            }
        }
#ifdef SIMULATOR_SOURCE_DIR
        candidates.push_back(fs::u8path(SIMULATOR_SOURCE_DIR));
#endif
        candidates.push_back(fs::u8path(__FILE__).parent_path().parent_path());
    }
    for (const auto& candidate : candidates) {
        std::error_code error;
        const auto root = fs::canonical(candidate, error);
        if (!error && regular_file(root / "index.html") && regular_file(root / "src" / "app.js")) return root;
    }
    throw std::runtime_error("Cannot locate index.html and src/app.js. Run from the project directory or pass --root <project-directory>.");
}

struct Options {
    unsigned short port = 3000;
    std::optional<fs::path> root;
    bool help = false;
};

Options options(int argc, char* argv[]) {
    Options parsed;
    for (int index = 1; index < argc; ++index) {
        const std::string argument = argv[index];
        if (argument == "--help" || argument == "-h") parsed.help = true;
        else if (argument == "--root" && index + 1 < argc) parsed.root = argv[++index];
        else if (argument == "--port" && index + 1 < argc) {
            const std::string value = argv[++index];
            if (value.empty() || value.size() > 5 || !std::all_of(value.begin(), value.end(), [](unsigned char c) { return std::isdigit(c) != 0; })) {
                throw std::runtime_error("--port requires an integer from 0 to 65535.");
            }
            const auto number = std::stoul(value);
            if (number > 65535) throw std::runtime_error("--port must be between 0 and 65535.");
            parsed.port = static_cast<unsigned short>(number);
        } else throw std::runtime_error("Unknown or incomplete option: " + argument + ". Use --help.");
    }
    return parsed;
}

void configure_client(SocketHandle client) {
#ifdef _WIN32
    const DWORD timeout = 5000;
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
#else
    const timeval timeout{5, 0};
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
#endif
}

bool send_all(SocketHandle socket, const std::string& bytes) {
    std::size_t sent = 0;
    while (sent < bytes.size()) {
        const auto length = static_cast<int>(std::min(bytes.size() - sent, static_cast<std::size_t>(std::numeric_limits<int>::max())));
        const auto result = ::send(socket, bytes.data() + sent, length, 0);
        if (result <= 0) {
#ifndef _WIN32
            if (result < 0 && errno == EINTR) continue;
#endif
            return false;
        }
        sent += static_cast<std::size_t>(result);
    }
    return true;
}

void respond(SocketHandle socket, int status, std::string_view reason, std::string_view type,
             const std::string& body, bool head = false, std::string_view extra_headers = {}) {
    std::ostringstream response;
    response << "HTTP/1.1 " << status << ' ' << reason << "\r\n"
             << "Connection: close\r\n"
             << "Content-Length: " << body.size() << "\r\n"
             << "X-Content-Type-Options: nosniff\r\n"
             << "Referrer-Policy: no-referrer\r\n"
             << "Cache-Control: no-store\r\n"
             << "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'\r\n";
    if (!type.empty()) response << "Content-Type: " << type << "\r\n";
    response << extra_headers << "\r\n";
    if (!head && status != 204) response << body;
    send_all(socket, response.str());
}

int hex_value(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

std::optional<std::string> decoded_path(std::string target) {
    if (target.empty() || target.front() != '/') return std::nullopt;
    target = target.substr(0, target.find('?'));
    std::string path;
    for (std::size_t index = 0; index < target.size(); ++index) {
        unsigned char value = static_cast<unsigned char>(target[index]);
        if (value == '%') {
            if (index + 2 >= target.size()) return std::nullopt;
            const int high = hex_value(target[index + 1]);
            const int low = hex_value(target[index + 2]);
            if (high < 0 || low < 0) return std::nullopt;
            value = static_cast<unsigned char>(high * 16 + low);
            index += 2;
        }
        if (value < 0x20 || value == 0x7f) return std::nullopt;
        path.push_back(static_cast<char>(value));
    }
    return path;
}

bool public_asset(const std::string& path) {
    if (path == "/" || path == "/index.html") return true;
    if (path.rfind("/src/", 0) != 0) return false;
    const auto name = path.substr(5);
    const auto extension = name.find('.');
    if (extension == std::string::npos || extension == 0) return false;
    const auto suffix = name.substr(extension);
    if (suffix != ".js" && suffix != ".css") return false;
    return std::all_of(name.begin(), name.begin() + static_cast<std::ptrdiff_t>(extension), [](unsigned char value) {
        return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
               (value >= '0' && value <= '9') || value == '_' || value == '-';
    });
}

bool inside_root(const fs::path& root, const fs::path& file) {
    auto root_part = root.begin();
    auto file_part = file.begin();
    for (; root_part != root.end(); ++root_part, ++file_part) {
        if (file_part == file.end() || *root_part != *file_part) return false;
    }
    return file_part != file.end();
}

void serve_client(SocketHandle client, const fs::path& root) {
    configure_client(client);
    constexpr std::size_t maximum_headers = 16 * 1024;
    std::string request;
    char buffer[2048];
    while (request.find("\r\n\r\n") == std::string::npos) {
        const auto length = ::recv(client, buffer, sizeof(buffer), 0);
        if (length <= 0) return;
        request.append(buffer, static_cast<std::size_t>(length));
        if (request.size() > maximum_headers) {
            respond(client, 431, "Request Header Fields Too Large", "text/plain; charset=utf-8", "Request too large");
            return;
        }
    }
    const auto line_end = request.find("\r\n");
    std::istringstream line(request.substr(0, line_end));
    std::string method, target, version, extra;
    line >> method >> target >> version;
    if (method.empty() || target.empty() || (version != "HTTP/1.1" && version != "HTTP/1.0") || (line >> extra)) {
        respond(client, 400, "Bad Request", "text/plain; charset=utf-8", "Invalid request");
        return;
    }
    const bool head = method == "HEAD";
    if (method != "GET" && !head) {
        respond(client, 405, "Method Not Allowed", "text/plain; charset=utf-8", "Method not allowed", false, "Allow: GET, HEAD\r\n");
        return;
    }
    const auto path = decoded_path(target);
    if (!path) {
        respond(client, 400, "Bad Request", "text/plain; charset=utf-8", "Invalid URL", head);
        return;
    }
    if (*path == "/health") {
        respond(client, 200, "OK", "application/json; charset=utf-8", "{\"status\":\"ok\",\"application\":\"simulator-jednotky\"}", head);
        return;
    }
    if (*path == "/favicon.ico") {
        respond(client, 204, "No Content", "", "", head);
        return;
    }
    if (!public_asset(*path)) {
        respond(client, 404, "Not Found", "text/plain; charset=utf-8", "Not found", head);
        return;
    }
    std::error_code error;
    const auto file = fs::canonical(root / (*path == "/" ? "index.html" : path->substr(1)), error);
    if (error || !inside_root(root, file) || !regular_file(file)) {
        respond(client, 404, "Not Found", "text/plain; charset=utf-8", "Not found", head);
        return;
    }
    std::ifstream input(file, std::ios::binary);
    if (!input) {
        respond(client, 500, "Internal Server Error", "text/plain; charset=utf-8", "Unable to read application file", head);
        return;
    }
    const std::string body((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    if (input.bad()) {
        respond(client, 500, "Internal Server Error", "text/plain; charset=utf-8", "Unable to read application file", head);
        return;
    }
    const auto extension = file.extension().string();
    const auto type = extension == ".html" ? "text/html; charset=utf-8" :
                      extension == ".js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
    respond(client, 200, "OK", type, body, head);
}
} // namespace

int main(int argc, char* argv[]) {
    try {
        const auto parsed = options(argc, argv);
        if (parsed.help) {
            std::cout << "Formula Lab - native simulator entry point\n"
                         "Usage: simulator [--port 0..65535] [--root project-directory]\n"
                         "Default: 127.0.0.1:3000. Port 0 selects an available port.\n"
                         "The browser runs the vehicle/controller model. This program serves its files.\n";
            return 0;
        }
        const auto root = project_root(parsed.root, argv[0]);
        const SocketRuntime runtime;
        (void)runtime;
        const Socket listener(::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP));
        if (listener.get() == invalid_socket) network_error("socket");
#ifndef _WIN32
        const int reuse = 1;
        setsockopt(listener.get(), SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
#endif
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        address.sin_port = htons(parsed.port);
        if (::bind(listener.get(), reinterpret_cast<const sockaddr*>(&address), sizeof(address)) != 0) network_error("bind (port may already be in use)");
        if (::listen(listener.get(), 32) != 0) network_error("listen");
        SocketLength address_length = sizeof(address);
        if (::getsockname(listener.get(), reinterpret_cast<sockaddr*>(&address), &address_length) != 0) network_error("getsockname");
        std::cout << "Formula Lab listening on http://127.0.0.1:" << ntohs(address.sin_port) << '\n'
                  << "Application files: " << root.string() << '\n'
                  << "Open that address in Chrome or Edge. Stop with Ctrl+C." << std::endl;
        for (;;) {
            const Socket client(::accept(listener.get(), nullptr, nullptr));
            if (client.get() == invalid_socket) {
#ifndef _WIN32
                if (errno == EINTR) continue;
#endif
                network_error("accept");
            }
            try { serve_client(client.get(), root); }
            catch (const std::exception&) {
                respond(client.get(), 500, "Internal Server Error", "text/plain; charset=utf-8", "Unable to serve request");
            }
        }
    } catch (const std::exception& error) {
        std::cerr << "Formula Lab: " << error.what() << std::endl;
        return 1;
    }
}
