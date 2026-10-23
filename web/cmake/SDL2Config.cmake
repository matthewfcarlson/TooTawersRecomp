# (web port) find_package(SDL2) for Emscripten: SDL2 is Emscripten's own port
# (-sUSE_SDL=2), so the toolkit's CMake files are used unchanged.
if(NOT TARGET SDL2::SDL2)
    add_library(SDL2::SDL2 INTERFACE IMPORTED)
    set_target_properties(SDL2::SDL2 PROPERTIES
        INTERFACE_COMPILE_OPTIONS "-sUSE_SDL=2"
        INTERFACE_LINK_OPTIONS "-sUSE_SDL=2")
endif()
set(SDL2_FOUND TRUE)
