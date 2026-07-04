// ============================================================================
// NAM A2 RIG — AUDIO-BRIDGE SIDECAR (arch §9's "one hard part, quarantined")
//
// Joins Live's Ableton Link Audio session as a SOURCE, receives one published
// channel (Live's Main), and streams the buffers to the hub as Contract-5
// APC1 records over loopback TCP. That's its entire job — build once, leave
// alone; everything else iterates in Node behind the frozen socket seam.
//
// GROUNDING: written against the real ableton/LinkAudio.hpp (master,
// GPL-2.0-or-later — fine, the tool ships open source, arch §9/§14):
//   LinkAudioSource(link, channelId, callback) → callback(BufferHandle{
//     int16_t* samples; Info{numChannels,numFrames,sampleRate,count,
//     sessionBeatTime,tempo,sessionId} })   — interleaved 16-bit signed.
// The APC1 header mirrors Info losslessly (Contract 5); byte layout is pinned
// by hub/test's golden AND by this file's --selftest, which prints the
// identical golden hex so the two languages can never drift.
//
// MODES
//   ./nam_a2_sidecar                join Link, wait for a channel matching
//                                   NAM_CHANNEL (default: "main", substring,
//                                   case-insensitive), stream to the hub
//   ./nam_a2_sidecar --selftest     print the golden APC1 header (no Link)
//   ./nam_a2_sidecar --fake N       stream N synthetic sine packets to the hub
//                                   (no Link/Live needed) — lets the hub's
//                                   parser/reslicer/WebRTC path be tested
//                                   end-to-end with zero hardware
//
// ENV:  NAM_HUB_HOST (127.0.0.1)  NAM_HUB_PORT (47615)  NAM_CHANNEL ("main")
// ============================================================================

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

// POSIX sockets (macOS + Linux; the hub is loopback so nothing fancy needed)
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>

#ifndef SELFTEST_ONLY
#include <ableton/LinkAudio.hpp>
#endif

// ---------------------------------------------------------------------------
// Contract 5 — APC1 header (MUST match contracts/types/audio-sidecar.ts and
// the hub/test golden byte-for-byte; --selftest proves it)
// ---------------------------------------------------------------------------
namespace apc1 {
constexpr uint32_t kMagic = 0x41504331; // "APC1"
constexpr uint16_t kVersion = 1;
constexpr size_t kHeaderBytes = 40;
constexpr uint16_t kFlagDiscontinuity = 0x0001;

struct Header {
  uint16_t numChannels;
  uint32_t sampleRate;
  uint32_t numFrames; // per channel
  uint32_t sequence;
  double sessionBeatTime;
  double tempo;
  uint16_t flags;
};

inline void putU16(uint8_t* p, uint16_t v) { std::memcpy(p, &v, 2); }
inline void putU32(uint8_t* p, uint32_t v) { std::memcpy(p, &v, 4); }
inline void putF64(uint8_t* p, double v) { std::memcpy(p, &v, 8); }
// (memcpy of native values == little-endian on every target we run on:
//  Apple Silicon + x86. Contract 5 documents LE explicitly for any future BE reader.)

inline void writeHeader(uint8_t out[kHeaderBytes], const Header& h) {
  putU32(out + 0, kMagic);
  putU16(out + 4, kVersion);
  putU16(out + 6, h.numChannels);
  putU32(out + 8, h.sampleRate);
  putU32(out + 12, h.numFrames);
  putU32(out + 16, h.sequence);
  putF64(out + 20, h.sessionBeatTime);
  putF64(out + 28, h.tempo);
  putU16(out + 36, h.flags);
  putU16(out + 38, 0); // reserved
}
} // namespace apc1

// ---------------------------------------------------------------------------
// Hub connection: loopback TCP client with dumb reconnect. If the hub is down
// we drop audio (it's a live stream — stale audio is worse than a gap) and
// mark DISCONTINUITY on the first packet after reconnect.
// ---------------------------------------------------------------------------
class HubLink {
public:
  HubLink(std::string host, int port) : mHost(std::move(host)), mPort(port) {}

  bool sendPacket(const apc1::Header& h, const int16_t* samples) {
    std::lock_guard<std::mutex> lock(mMutex);
    if (mFd < 0 && !connectNow()) return false;
    uint8_t head[apc1::kHeaderBytes];
    apc1::writeHeader(head, h);
    const size_t payload = size_t(h.numChannels) * h.numFrames * 2;
    if (!writeAll(head, sizeof(head)) ||
        !writeAll(reinterpret_cast<const uint8_t*>(samples), payload)) {
      ::close(mFd);
      mFd = -1;
      return false;
    }
    return true;
  }

private:
  bool connectNow() {
    mFd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (mFd < 0) return false;
    int one = 1;
    ::setsockopt(mFd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one)); // audio = latency
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(uint16_t(mPort));
    ::inet_pton(AF_INET, mHost.c_str(), &addr.sin_addr);
    if (::connect(mFd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
      ::close(mFd);
      mFd = -1;
      return false;
    }
    std::fprintf(stderr, "[sidecar] connected to hub %s:%d\n", mHost.c_str(), mPort);
    return true;
  }

  bool writeAll(const uint8_t* p, size_t n) {
    while (n > 0) {
      const ssize_t w = ::send(mFd, p, n, 0);
      if (w <= 0) return false;
      p += w;
      n -= size_t(w);
    }
    return true;
  }

  std::string mHost;
  int mPort;
  int mFd = -1;
  std::mutex mMutex;
};

static std::string envOr(const char* name, const char* dflt) {
  const char* v = std::getenv(name);
  return v ? v : dflt;
}

// ---------------------------------------------------------------------------
// --selftest: print the golden header hex (same fixture as hub/test/hub.test.ts)
// ---------------------------------------------------------------------------
static int selftest() {
  apc1::Header h{2, 48000, 240, 7, 16.25, 92.5, 0}; // == hub/test codec fixture
  uint8_t out[apc1::kHeaderBytes];
  apc1::writeHeader(out, h);
  std::printf("APC1 golden header: ");
  for (uint8_t b : out) std::printf("%02x", b);
  std::printf("\nexpected (hub/test): 314350410100020080bb0000f0000000070000000000000000403040000000000020574000000000\n");
  return 0;
}

// ---------------------------------------------------------------------------
// --fake N: stream synthetic packets so the hub path is testable with no Live
// ---------------------------------------------------------------------------
static int fakeStream(int packets) {
  HubLink hub(envOr("NAM_HUB_HOST", "127.0.0.1"), std::stoi(envOr("NAM_HUB_PORT", "47615")));
  const uint32_t rate = 48000, framesPer = 300; // deliberately NOT 10ms — hub reslices
  std::vector<int16_t> buf(2 * framesPer);
  double phase = 0;
  for (int p = 0; p < packets; ++p) {
    for (uint32_t i = 0; i < framesPer; ++i) {
      const int16_t s = int16_t(12000 * std::sin(phase));
      buf[2 * i] = s;
      buf[2 * i + 1] = s;
      phase += 2.0 * 3.14159265358979 * 440.0 / rate;
    }
    apc1::Header h{2, rate, framesPer, uint32_t(p), p * framesPer / double(rate) * 2.0, 120.0,
                   uint16_t(p == 0 ? apc1::kFlagDiscontinuity : 0)};
    if (!hub.sendPacket(h, buf.data()))
      std::fprintf(stderr, "[sidecar] hub not reachable (packet %d dropped)\n", p);
    std::this_thread::sleep_for(std::chrono::microseconds(framesPer * 1000000ull / rate));
  }
  std::fprintf(stderr, "[sidecar] fake stream done (%d packets)\n", packets);
  return 0;
}

#ifndef SELFTEST_ONLY
// ---------------------------------------------------------------------------
// The real thing: join Link, find the channel, forward its buffers.
// ---------------------------------------------------------------------------
static bool nameMatches(const std::string& channelName, const std::string& want) {
  auto lower = [](std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
    return s;
  };
  return lower(channelName).find(lower(want)) != std::string::npos;
}

static int run() {
  const std::string want = envOr("NAM_CHANNEL", "main");
  HubLink hub(envOr("NAM_HUB_HOST", "127.0.0.1"), std::stoi(envOr("NAM_HUB_PORT", "47615")));

  ableton::LinkAudio link(120.0, "NAM A2 Hub");
  link.enable(true);           // join the Link session
  link.enableLinkAudio(true);  // announce/discover audio channels

  std::mutex sourceMutex;
  std::optional<ableton::LinkAudioSource> source;
  std::atomic<uint32_t> seq{0};
  std::atomic<uint64_t> lastCount{0};

  auto attach = [&](const ableton::BasicLinkAudio<ableton::link::platform::Clock>::Channel& ch) {
    std::fprintf(stderr, "[sidecar] subscribing to channel '%s'\n", ch.name.c_str());
    std::lock_guard<std::mutex> lock(sourceMutex);
    source.emplace(link, ch.id, [&](ableton::LinkAudioSource::BufferHandle buffer) {
      // Link-managed thread, sender's rate/block size (arch §14 receive note):
      // forward VERBATIM; the hub reslices to 10 ms.
      const auto& info = buffer.info;
      const uint64_t prev = lastCount.exchange(info.count);
      apc1::Header h{uint16_t(info.numChannels), info.sampleRate, uint32_t(info.numFrames),
                     seq.fetch_add(1), info.sessionBeatTime, info.tempo,
                     uint16_t(prev != 0 && info.count != prev + 1 ? apc1::kFlagDiscontinuity : 0)};
      hub.sendPacket(h, buffer.samples);
    });
  };

  link.setChannelsChangedCallback([&] {
    for (const auto& ch : link.channels()) {
      std::fprintf(stderr, "[sidecar] channel visible: '%s'\n", ch.name.c_str());
      if (nameMatches(ch.name, want)) {
        attach(ch);
        return;
      }
    }
  });

  std::fprintf(stderr,
               "[sidecar] joined Link as 'NAM A2 Hub'; waiting for a channel matching '%s'.\n"
               "[sidecar] In Live 12.4+: enable Link + Link Audio, publish the Main output.\n",
               want.c_str());
  for (;;) std::this_thread::sleep_for(std::chrono::seconds(1));
}
#endif

int main(int argc, char** argv) {
  if (argc > 1 && std::string(argv[1]) == "--selftest") return selftest();
  if (argc > 2 && std::string(argv[1]) == "--fake") return fakeStream(std::atoi(argv[2]));
#ifndef SELFTEST_ONLY
  return run();
#else
  std::fprintf(stderr, "built SELFTEST_ONLY (no Link headers); use --selftest / --fake\n");
  return 1;
#endif
}
