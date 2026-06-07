# Rebuild Dragon materials (wire packed textures into Principled BSDF), then export GLB.
# Usage: blender -b Dragon_Baked_Actions.blend -P fix_and_export.py -- <out.glb>
import bpy
import sys

out_path = sys.argv[sys.argv.index("--") + 1]

color_img = bpy.data.images.get("Dragon_Bump_Col.jpg.000")
normal_img = bpy.data.images.get("Dragon_Nor.jpg.001")

obj = bpy.data.objects["Dragon_Mesh"]
for slot in obj.material_slots:
    m = slot.material
    if not m or not m.use_nodes:
        continue
    nt = m.node_tree

    # Find the active output and its surface shader so we can read its old color.
    out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
    old_shader = out.inputs["Surface"].links[0].from_node if (out and out.inputs["Surface"].links) else None
    old_color = None
    if old_shader and "Base Color" in old_shader.inputs:
        old_color = tuple(old_shader.inputs["Base Color"].default_value)
    elif old_shader and "Color" in old_shader.inputs:
        old_color = tuple(old_shader.inputs["Color"].default_value)
    print(f"MATERIAL {m.name}: old shader={old_shader.type if old_shader else None} color={old_color}")

    # Rebuild from scratch: textured Principled BSDF.
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.8
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    if m.name.startswith("EYES"):
        # Eyes: plain dark color, no texture.
        bsdf.inputs["Base Color"].default_value = (0.02, 0.02, 0.02, 1.0)
        continue

    if color_img:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = color_img
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if normal_img:
        ntex = nt.nodes.new("ShaderNodeTexImage")
        ntex.image = normal_img
        ntex.image.colorspace_settings.name = "Non-Color"
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(ntex.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

bpy.ops.export_scene.gltf(
    filepath=out_path,
    export_format="GLB",
    export_animations=True,
    export_animation_mode="ACTIONS",
    export_bake_animation=True,
    export_image_format="AUTO",
    export_yup=True,
)
print(f"Exported: {out_path}")
