# NAM A2 audio-bridge sidecar. Needs the Ableton Link repo (with submodules):
#   git clone --recursive https://github.com/Ableton/link.git
#   cmake -B build -DLINK_DIR=/path/to/link && cmake --build build
cmake_minimum_required(VERSION 3.14)
project(nam_a2_sidecar CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT DEFINED LINK_DIR)
  message(FATAL_ERROR "Pass -DLINK_DIR=/path/to/ableton/link (cloned --recursive)")
endif()

# Use Link's own CMake config (defines Ableton::Link with platform flags + ASIO)
include(${LINK_DIR}/AbletonLinkConfig.cmake)

add_executable(nam_a2_sidecar main.cpp)
target_link_libraries(nam_a2_sidecar Ableton::Link)
# LinkAudio needs the link_audio sources' extra include path on some layouts:
target_include_directories(nam_a2_sidecar PRIVATE ${LINK_DIR}/include)
find_package(Threads REQUIRED)
target_link_libraries(nam_a2_sidecar Threads::Threads)
