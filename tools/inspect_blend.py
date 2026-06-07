# Print materials, their node setups, and images for each mesh object.
import bpy

for img in bpy.data.images:
    print(f"IMAGE: {img.name} | packed={img.packed_file is not None} | path={img.filepath}")

for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    print(f"\nMESH OBJECT: {obj.name}")
    for slot in obj.material_slots:
        m = slot.material
        if not m:
            continue
        print(f"  MATERIAL: {m.name} | use_nodes={m.use_nodes}")
        if m.use_nodes:
            for n in m.node_tree.nodes:
                extra = ""
                if n.type == "TEX_IMAGE" and n.image:
                    extra = f" image={n.image.name}"
                print(f"    node: {n.type}{extra}")
