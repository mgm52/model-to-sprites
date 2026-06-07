# Headless Blender script: export a .blend to .glb with all baked actions.
# Usage: blender -b <file.blend> -P blend_to_glb.py -- <out.glb>
import bpy
import sys

out_path = sys.argv[sys.argv.index("--") + 1]

# Report what we have so the user can see clips were found.
print("Actions in file:")
for a in bpy.data.actions:
    print(f"  - {a.name} ({a.frame_range[0]:.0f}-{a.frame_range[1]:.0f})")

# Pack external images so textures embed into the GLB.
try:
    bpy.ops.file.pack_all()
except RuntimeError as e:
    print(f"pack_all warning: {e}")

bpy.ops.export_scene.gltf(
    filepath=out_path,
    export_format="GLB",
    export_animations=True,
    export_animation_mode="ACTIONS",  # one clip per action
    export_bake_animation=True,
    export_image_format="AUTO",
    export_yup=True,
)
print(f"Exported: {out_path}")
