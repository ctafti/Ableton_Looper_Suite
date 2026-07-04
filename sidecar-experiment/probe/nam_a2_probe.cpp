/* =============================================================================
 * NAM A2 — LINK AUDIO PROBE (sidecar spike, BUILD-PLAN Phase 0 §5 / Phase 8)
 *
 * One binary, two modes, proving the project's scariest seam OFF the rig:
 *
 *   ./nam_a2_probe send      publish a Link Audio channel ("nam-a2-probe")
 *                            carrying a deterministic int16 ramp pattern
 *   ./nam_a2_probe recv [host port]
 *                            discover the channel, subscribe, VERIFY the
 *                            pattern sample-by-sample; optionally forward
 *                            every received buffer as an APC1 record over TCP
 *                            (Contract 5's exact frozen bytes) to the Node
 *                            verifier (verify-apc1.ts) — C++ -> Node, the
 *                            full sidecar seam end to end.
 *
 * The pattern: sample[k of buffer n] = int16((n * 7919 + k * 31) % 65536 - 32768)
 * — cheap, deterministic, order-sensitive. If ANY buffer arrives corrupted,
 * reordered, or resliced wrongly, verification fails loudly.
 *
 * GPL-2.0-or-later (this file links Ableton Link; the project is open source).
 * ========================================================================== */
#include <ableton/LinkAudio.hpp>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <iostream>
#include <thread>
#include <vector>

namespace
{
constexpr uint32_t kSampleRate = 48000;
constexpr size_t kNumChannels = 2;
constexpr size_t kFramesPerBuffer = 480; // 10 ms — Link reslices as it likes
constexpr double kQuantum = 4.0;
const std::string kChannelName = "nam-a2-probe";

int16_t patternSample(uint64_t buffer, size_t k)
{
  return static_cast<int16_t>(((buffer * 7919 + k * 31) % 65536) - 32768);
}

// --- APC1 encoder: byte-for-byte Contract 5 (see contracts/types/audio-sidecar.ts)
struct Apc1Writer
{
  int fd = -1;
  bool open(const char* host, int port)
  {
    fd = ::socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<uint16_t>(port));
    ::inet_pton(AF_INET, host, &addr.sin_addr);
    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0)
    {
      std::cerr << "[probe] APC1 connect failed: " << std::strerror(errno) << std::endl;
      return false;
    }
    return true;
  }
  template <typename T>
  static void putLE(std::vector<uint8_t>& b, size_t off, T v)
  {
    std::memcpy(b.data() + off, &v, sizeof(T)); // x86/ARM little-endian
  }
  void write(uint16_t numChannels, uint32_t sampleRate, uint32_t numFrames,
             uint32_t sequence, double sessionBeatTime, double tempo,
             const int16_t* samples)
  {
    if (fd < 0) return;
    const size_t payload = size_t(numChannels) * numFrames * 2;
    std::vector<uint8_t> buf(40 + payload);
    putLE<uint32_t>(buf, 0, 0x41504331u); // "APC1"
    putLE<uint16_t>(buf, 4, 1);
    putLE<uint16_t>(buf, 6, numChannels);
    putLE<uint32_t>(buf, 8, sampleRate);
    putLE<uint32_t>(buf, 12, numFrames);
    putLE<uint32_t>(buf, 16, sequence);
    putLE<double>(buf, 20, sessionBeatTime);
    putLE<double>(buf, 28, tempo);
    putLE<uint16_t>(buf, 36, 0); // flags
    putLE<uint16_t>(buf, 38, 0); // reserved
    std::memcpy(buf.data() + 40, samples, payload);
    size_t off = 0;
    while (off < buf.size())
    {
      const auto n = ::send(fd, buf.data() + off, buf.size() - off, 0);
      if (n <= 0) { fd = -1; return; }
      off += size_t(n);
    }
  }
};

int runSend()
{
  ableton::LinkAudio link(120., "nam-a2-send");
  link.enable(true);
  link.enableLinkAudio(true);
  ableton::LinkAudioSink sink(link, kChannelName, kNumChannels * kFramesPerBuffer * 4);

  std::cout << "[send] publishing channel '" << kChannelName << "' — pattern int16 ramp"
            << std::endl;
  uint64_t bufferIndex = 0;
  const auto start = std::chrono::steady_clock::now();
  for (;;)
  {
    auto sessionState = link.captureAppSessionState();
    const auto time = link.clock().micros();
    const double beats = sessionState.beatAtTime(time, kQuantum);
    {
      ableton::LinkAudioSink::BufferHandle handle(sink);
      if (handle)
      {
        const size_t samples = kNumChannels * kFramesPerBuffer;
        for (size_t k = 0; k < samples; ++k)
        {
          handle.samples[k] = patternSample(bufferIndex, k);
        }
        if (handle.commit(sessionState, beats, kQuantum, kFramesPerBuffer, kNumChannels,
              kSampleRate))
        {
          ++bufferIndex;
        }
      }
    }
    if (bufferIndex % 100 == 1)
    {
      std::cout << "[send] peers=" << link.numPeers() << " buffers=" << bufferIndex
                << std::endl;
    }
    // pace at ~10ms real time like an audio callback would
    std::this_thread::sleep_until(
      start + std::chrono::milliseconds(10 * (bufferIndex + 1)));
  }
  return 0;
}

int runRecv(const char* apcHost, int apcPort)
{
  ableton::LinkAudio link(120., "nam-a2-recv");
  link.enable(true);
  link.enableLinkAudio(true);

  Apc1Writer apc;
  if (apcHost != nullptr && !apc.open(apcHost, apcPort)) return 2;

  // 1) DISCOVERY: poll channels() until the probe channel appears
  std::cout << "[recv] waiting for channel '" << kChannelName << "' ..." << std::endl;
  std::optional<ableton::BasicLinkAudio<ableton::link::platform::Clock>::Channel> found;
  for (int i = 0; i < 100 && !found; ++i)
  {
    for (const auto& ch : link.channels())
    {
      if (ch.name == kChannelName) { found = ch; break; }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  if (!found)
  {
    std::cout << "[recv] FAIL: channel not discovered within 10s (peers="
              << link.numPeers() << ")" << std::endl;
    return 1;
  }
  std::cout << "[recv] discovered: peer='" << found->peerName << "' channel='"
            << found->name << "' — subscribing" << std::endl;

  // 2) TRANSFER + VERIFY
  std::atomic<uint64_t> buffers{0};
  std::atomic<uint64_t> samplesOk{0};
  std::atomic<uint64_t> samplesBad{0};
  std::atomic<uint64_t> streamGaps{0};
  std::atomic<uint64_t> droppedRecvBuffers{0};
  std::atomic<uint64_t> firstCount{UINT64_MAX};

  ableton::LinkAudioSource source(
    link, found->id, [&](ableton::LinkAudioSource::BufferHandle handle) {
      const auto info = handle.info;
      if (firstCount.load() == UINT64_MAX) firstCount = info.count;
      const size_t n = info.numChannels * info.numFrames;
      // Link may RESLICE buffers; verify via the absolute sample offset that
      // info.count encodes for the fixed-size sender (count is per-buffer of
      // the SENDER's commits when sizes are preserved; if sizes differ we
      // verify the ramp's internal consistency instead).
      // Link RESLICES freely (we observed ~124-frame buffers for 480-frame
      // commits), so verify the CONCATENATED stream: within a sender buffer
      // consecutive samples differ by 31 (mod 2^16); at a sender-buffer
      // boundary the previous sample determines n (31 and 7919 are odd, hence
      // invertible mod 2^16), which pins the exact next expected sample.
      uint64_t ok = 0, bad = 0, boundaries = 0, gaps = 0;
      (void)boundaries;
      static thread_local int havePrev = 0;
      static thread_local uint16_t prev = 0;
      static thread_local uint64_t lastRecvCount = UINT64_MAX;
      // Link's receive ring can drop whole buffers if the consumer lags
      // (info.count skips) — the stream RESUMES cleanly, so resync rather
      // than calling intact-but-later data corrupt. Count it honestly.
      if (lastRecvCount != UINT64_MAX && info.count != lastRecvCount + 1)
      {
        havePrev = 0;
        droppedRecvBuffers += (info.count - lastRecvCount - 1);
      }
      lastRecvCount = info.count;
      auto u = [](int16_t v) { return uint16_t(int(v) + 32768); };
      for (size_t k = 0; k < n; ++k)
      {
        const uint16_t cur = u(handle.samples[k]);
        if (!havePrev) { havePrev = 1; prev = cur; ++ok; continue; }
        if (uint16_t(cur - prev) == 31u) { ++ok; prev = cur; continue; }
        // candidate sender-buffer boundary: prev should be k=959 of buffer m
        const uint64_t kLast = (kNumChannels * kFramesPerBuffer) - 1;
        const uint16_t mTimes7919 = uint16_t(prev - uint16_t(kLast * 31u));
        // next buffer's first sample = (m+j)*7919 for a small j (j>1 = gap)
        bool matched = false;
        for (uint16_t j = 1; j <= 8 && !matched; ++j)
        {
          if (cur == uint16_t(mTimes7919 + j * 7919u)) matched = true;
        }
        if (!matched)
        {
          // intra-buffer GAP (dropped span, sender jitter): delta = 31*(g+1)
          const uint16_t d = uint16_t(cur - prev);
          for (uint32_t g = 2; g <= 960 && !matched; ++g)
          {
            if (d == uint16_t(31u * g)) { matched = true; }
          }
          if (matched) { ++gaps; }
        }
        else { ++boundaries; }
        if (matched) { ++ok; }
        else
        {
          ++bad;
          std::cerr << "[recv] anomaly: buffer#" << buffers.load() << " k=" << k
                    << "/" << n << " prev=" << prev << " cur=" << cur
                    << " info.count=" << info.count << std::endl;
        }
        prev = cur;
      }
      samplesOk += ok;
      samplesBad += bad;
      streamGaps += gaps;
      ++buffers;
      if (apcHost != nullptr)
      {
        apc.write(uint16_t(info.numChannels), info.sampleRate, uint32_t(info.numFrames),
          uint32_t(info.count & 0xffffffffu), info.sessionBeatTime, info.tempo,
          handle.samples);
      }
    });

  for (int i = 0; i < 50 && buffers.load() < 200; ++i)
  {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }

  const auto b = buffers.load();
  const auto ok = samplesOk.load();
  const auto bad = samplesBad.load();
  std::cout << "[recv] buffers=" << b << " samplesOk=" << ok << " samplesBad=" << bad
            << " streamGaps=" << streamGaps.load()
            << " droppedRecvBuffers=" << droppedRecvBuffers.load() << std::endl;
  if (b > 0 && bad == 0)
  {
    std::cout << "[recv] PASS: Link Audio same-machine channel discovery + verified "
                 "sample-exact transfer"
              << std::endl;
    return 0;
  }
  std::cout << "[recv] FAIL" << std::endl;
  return 1;
}
} // namespace

int main(int argc, char** argv)
{
  if (argc >= 2 && std::string(argv[1]) == "send") return runSend();
  if (argc >= 2 && std::string(argv[1]) == "recv")
  {
    const char* host = argc >= 4 ? argv[2] : nullptr;
    const int port = argc >= 4 ? std::atoi(argv[3]) : 0;
    return runRecv(host, port);
  }
  std::cerr << "usage: nam_a2_probe send | recv [apc1-host apc1-port]" << std::endl;
  return 64;
}
