"""
Print the upper arm bone's world matrix and render a close-up of the arm.

The earlier dump inferred the bone's direction from its local Z and got an
answer that contradicts the render, so this prints the bone's actual world
matrix - its translation is the tail in world space and its columns are the
bone's local axes in world space - and renders the arm large enough to see.
"""

import sys
import os
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
src, outdir = argv[0], argv[1]
os.makedirs(outdir, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

arm = [o for o in bpy.data.objects if o.type == "ARMATURE"][0]
aw = arm.matrix_world

for name in ["clavicle_l_27", "upperarm_l_26", "lowerarm_l_23", "hand_l_20"]:
    pb = arm.pose.bones.get(name)
    if pb is None:
        continue
    m = aw @ pb.matrix
    print(f"\n[arm] {name}  length={pb.length:.2f}")
    print(f"  world matrix translation (tail): {tuple(round(v,2) for v in m.translation)}")
    for label, col in (("X", m.col[0]), ("Y", m.col[1]), ("Z", m.col[2])):
        d = Vector((col.x, col.y, col.z)).normalized()
        print(f"  local {label} -> world {d.x:6.2f} {d.y:6.2f} {d.z:6.2f}")
    print(f"  head (armature space) {tuple(round(v,2) for v in pb.head)}  tail {tuple(round(v,2) for v in pb.tail)}")
    print(f"  head world {tuple(round(v,2) for v in (aw @ pb.head))}  tail world {tuple(round(v,2) for v in (aw @ pb.tail))}")

# Close-up render of the left arm.
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
lo = Vector((1e9,) * 3); hi = Vector((-1e9,) * 3)
for m in meshes:
    for c in m.bound_box:
        w = m.matrix_world @ Vector(c)
        for i in range(3):
            lo[i] = min(lo[i], w[i]); hi[i] = max(hi[i], w[i])
centre = (lo + hi) / 2
height = hi.z - lo.z

scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.render.resolution_x = 600
scene.render.resolution_y = 600

cam_data = bpy.data.cameras.new("Cam")
cam_data.type = "ORTHO"
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

# Left shoulder region, from the front.
target = centre + Vector((height * 0.10, 0, height * 0.28))
cam_data.ortho_scale = height * 0.30
for nm, pos in {
    "arm-front": target + Vector((0, -height * 0.8, 0)),
    "arm-side":  target + Vector((height * 0.8, 0, 0)),
}.items():
    cam.location = pos
    cam.rotation_euler = (target - pos).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = os.path.join(outdir, f"jinx-{nm}.png")
    bpy.ops.render.render(write_still=True)
    print(f"[arm] wrote {scene.render.filepath}")
