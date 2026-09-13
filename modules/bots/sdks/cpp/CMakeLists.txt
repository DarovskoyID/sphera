cmake_minimum_required(VERSION 3.16)
project(sfera_bot VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(CURL REQUIRED)

add_library(sfera_bot src/bot.cpp)
add_library(sfera::bot ALIAS sfera_bot)

target_include_directories(sfera_bot PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>
)
target_link_libraries(sfera_bot PUBLIC CURL::libcurl)

option(SFERA_BOT_BUILD_EXAMPLES "Собирать примеры" OFF)
if(SFERA_BOT_BUILD_EXAMPLES)
    add_executable(echo_bot examples/echo_bot.cpp)
    target_link_libraries(echo_bot PRIVATE sfera_bot)
endif()

option(SFERA_BOT_BUILD_TESTS "Собирать тесты" OFF)
if(SFERA_BOT_BUILD_TESTS)
    enable_testing()
    add_executable(sfera_bot_tests tests/test_json.cpp)
    target_link_libraries(sfera_bot_tests PRIVATE sfera_bot)
    add_test(NAME sfera_bot_tests COMMAND sfera_bot_tests)
endif()

install(TARGETS sfera_bot ARCHIVE DESTINATION lib)
install(DIRECTORY include/ DESTINATION include)
