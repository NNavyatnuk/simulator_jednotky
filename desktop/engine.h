#pragma once
#include <QJsonObject>
#include <QString>
#include <chrono>
#include <quickjs.h>

// No filesystem, socket, DOM or native OS bindings are exposed to JavaScript.
class Engine {
public:
    Engine();
    ~Engine();
    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;
    QJsonObject call(const QString& command, const QJsonObject& args = {});
private:
    JSRuntime* runtime_ = nullptr;
    JSContext* context_ = nullptr;
    std::chrono::steady_clock::time_point deadline_;
    QString exception();
    static JSModuleDef* load(JSContext*, const char*, void*);
    static int interrupt(JSRuntime*, void*);
};
