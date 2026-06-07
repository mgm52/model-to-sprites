# model → sprites

A browser tool for turning 3D models into directional 2D spritesheets.

Built with [three.js](https://threejs.org/)

## Features

- Load **.glb / .gltf / .fbx** models via file picker or drag & drop
- Merge animation clips from separate files (e.g. Mixamo FBX animations) onto a loaded rig
- Live 3D preview with orbit controls
- Render N directions × M frames per direction into a PNG spritesheet
- Orthographic or perspective camera, adjustable pitch, distance, and vertical offset
- Clip trimming (start/end %), auto-crop with padding, optional background color
- Configurable layout (rows = directions or columns = directions), start angle, rotation direction
- Animated preview strip with per-direction compass headings (N/NE/E/…)
- Exports the spritesheet PNG plus a JSON metadata file (frame layout, headings, camera settings)

## Usage

Serve the folder with any static file server and open it in a browser:

```sh
npx serve .
# or
python -m http.server
```

> A server is required (rather than opening `index.html` directly) because the app fetches three.js via an import map and discovers preset animations from the `maximo_animations/` directory listing.

1. Drop a rigged model (.glb/.gltf/.fbx) onto the viewport
2. Pick an animation clip, or drop another file to merge its clips onto the rig
3. Adjust camera, sprite size, directions, and frames in the sidebar
4. Hit **Render spritesheet**, then download the PNG + JSON

If the directional preview arrows don't match the silhouettes, change **Rest forward** to the axis your model faces in its bind pose.

## Blender helper scripts (`tools/`)

Headless Blender scripts for preparing models:

- `blend_to_glb.py` — export a .blend to .glb with all actions baked as clips:
  `blender -b file.blend -P tools/blend_to_glb.py -- out.glb`
- `fix_and_export.py` — rebuild materials (wire packed textures into Principled BSDF) before export
- `inspect_blend.py` — print meshes, materials, node setups, and images in a .blend

## Notes

- `maximo_animations/` contains Mixamo animation presets the app can lazily load and retarget onto a compatible rig (bone names must match)
- Sprites are rendered at up to 4× internal resolution and downscaled for sharpness
