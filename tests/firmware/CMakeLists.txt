# Host build of the portable firmware components + unit tests (no ESP-IDF needed).
cmake_minimum_required(VERSION 3.16)
project(mt_host_tests C)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
enable_testing()
find_package(OpenSSL REQUIRED)

set(FW ${CMAKE_CURRENT_SOURCE_DIR}/../../firmware/components)
set(PORTABLE
  ${FW}/math_engine/src/math_engine.c ${FW}/math_engine/src/solvers.c
  ${FW}/display/src/font.c ${FW}/display/src/font_data.c ${FW}/display/src/framebuffer.c ${FW}/display/src/display.c
  ${FW}/math_renderer/src/math_renderer.c
  ${FW}/virtual_keyboard/src/text_input.c
  ${FW}/security/src/security_common.c ${FW}/security/src/security_openssl.c
  ${FW}/settings/src/settings.c
  ${FW}/authentication/src/authentication.c
  ${FW}/history/src/vault.c ${FW}/favorites/src/favorites.c
  ${FW}/formulas/src/formulas.c ${FW}/formulas/src/formulas_data.c
  ${FW}/conversions/src/conversions.c ${FW}/conversions/src/conversions_data.c
  ${FW}/ai_client/src/ai_client.c ${FW}/ai_client/src/ai_response.c
  ${FW}/privacy_lock/src/privacy_lock.c
  ${FW}/power_manager/src/power_manager.c
  ${FW}/keypad/src/keypad_core.c
  ${FW}/calculator/src/calculator.c
  ${FW}/camera/src/camera_common.c ${FW}/wifi/src/wifi_common.c ${FW}/ota/src/ota_common.c
  ${FW}/app_state/src/app_state.c ${FW}/app_state/src/app_views.c ${FW}/app_state/src/app_screens.c
  third_party/cJSON/cJSON.c)

add_library(mt_portable STATIC ${PORTABLE})
target_include_directories(mt_portable PUBLIC
  ${FW}/math_engine/include ${FW}/display/include ${FW}/math_renderer/include ${FW}/virtual_keyboard/include
  ${FW}/security/include ${FW}/settings/include ${FW}/authentication/include ${FW}/history/include ${FW}/favorites/include
  ${FW}/formulas/include ${FW}/conversions/include ${FW}/ai_client/include ${FW}/privacy_lock/include
  ${FW}/power_manager/include ${FW}/keypad/include ${FW}/calculator/include ${FW}/camera/include ${FW}/wifi/include
  ${FW}/ota/include ${FW}/app_state/include third_party/cJSON src)
target_compile_options(mt_portable PRIVATE -Wall -Wextra -Wno-unused-parameter)
set_source_files_properties(third_party/cJSON/cJSON.c PROPERTIES COMPILE_OPTIONS "-w")
target_link_libraries(mt_portable PUBLIC OpenSSL::Crypto m)

option(MT_SANITIZE "Build tests with ASan/UBSan" ON)
if(MT_SANITIZE)
  target_compile_options(mt_portable PUBLIC -fsanitize=address,undefined -fno-omit-frame-pointer)
  target_link_options(mt_portable PUBLIC -fsanitize=address,undefined)
endif()

foreach(t math_engine ui_core security_storage ai_client app_state)
  add_executable(test_${t} src/test_${t}.c)
  target_link_libraries(test_${t} PRIVATE mt_portable)
  target_compile_options(test_${t} PRIVATE -Wall -Wextra -Wno-unused-parameter)
  add_test(NAME ${t} COMMAND test_${t})
endforeach()
