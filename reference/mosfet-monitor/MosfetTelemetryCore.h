#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>

namespace MosfetUsbTelemetry {

struct Observation {
    uint64_t sequence;
    uint64_t timeUs;
    bool fet1;
    bool fet2;
};

// The collector has no device bindings. Sequence numbers count attempted
// reports, including reports that cannot fit in the producer's queue.
class Collector {
public:
    bool sample(uint64_t timeUs, bool fet1, bool fet2, Observation& observation) {
        if (initialized_ && fet1 == fet1_ && fet2 == fet2_ && timeUs - lastReportUs_ < 50000) return false;
        observation = {sequence_++, timeUs, fet1, fet2};
        initialized_ = true;
        fet1_ = fet1;
        fet2_ = fet2;
        lastReportUs_ = timeUs;
        return true;
    }
private:
    uint64_t sequence_ = 0;
    uint64_t lastReportUs_ = 0;
    bool initialized_ = false;
    bool fet1_ = false;
    bool fet2_ = false;
};

inline size_t format(const Observation& observation, char* buffer, size_t capacity) {
    // The leading newline separates telemetry from an unfinished debug print.
    const int length = std::snprintf(buffer, capacity, "\nMOSFET,1,gpio,%llu,%llu,%u,%u\n",
        static_cast<unsigned long long>(observation.sequence),
        static_cast<unsigned long long>(observation.timeUs),
        observation.fet1 ? 1U : 0U, observation.fet2 ? 1U : 0U);
    return length > 0 && static_cast<size_t>(length) < capacity ? static_cast<size_t>(length) : 0;
}

} // namespace MosfetUsbTelemetry
