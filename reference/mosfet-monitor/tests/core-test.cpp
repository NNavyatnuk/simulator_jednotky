#include "../MosfetTelemetryCore.h"
#include <cassert>
#include <cstring>

int main() {
    using namespace MosfetUsbTelemetry;
    Collector collector;
    Observation report{};
    assert(collector.sample(1000, false, false, report));
    assert(report.sequence == 0 && report.timeUs == 1000 && !report.fet1 && !report.fet2);
    assert(!collector.sample(2000, false, false, report));
    assert(!collector.sample(50999, false, false, report));
    assert(collector.sample(51000, false, false, report)); // exact 50ms heartbeat
    assert(report.sequence == 1);
    assert(collector.sample(52000, true, false, report));
    const auto pulseStart = report.timeUs;
    assert(report.sequence == 2 && report.fet1 && !report.fet2);
    assert(collector.sample(102000, true, false, report)); // heartbeat within pulse
    assert(collector.sample(152000, false, false, report));
    assert(report.timeUs - pulseStart == 100000 && report.sequence == 4);
    // Simulate the caller dropping this record because its queue is full.
    assert(collector.sample(153000, false, true, report));
    assert(report.sequence == 5);
    assert(collector.sample(203000, false, false, report));
    assert(report.sequence == 6); // receiver detects the absent sequence 5
    char line[96]{};
    const size_t length = format(report, line, sizeof(line));
    assert(length == std::strlen(line));
    assert(std::strcmp(line, "\nMOSFET,1,gpio,6,203000,0,0\n") == 0);
    char tiny[8]{};
    assert(format(report, tiny, sizeof(tiny)) == 0); // no partial record accepted
    Collector longUptime;
    assert(longUptime.sample(5000000000ULL, true, true, report));
    assert(report.fet1 && report.fet2); // preserve conflicts rather than hide them
    assert(format(report, line, sizeof(line)) > 0);
    assert(std::strstr(line, ",5000000000,1,1\n")); // no 32-bit micros overflow
}
