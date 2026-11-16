"""
Render jinx.glb from a few angles so the pose and the braid can be seen.

    blender --background --factory-startup --python tools/blender-render.py -- jinx.glb outdir

Uses Workbench solid shading: fast in background mode, and it shows silhouette
and volume, which is what the T-pose and the braid shape are about.
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

meshes = [o for o in bpy.data.objects if o.type == "MESH"]
if not meshes:
    raise SystemExit("no meshes")

# Centre of the whole model, so every shot is framed on her.
lo = Vector((1e9, 1e9, 1e9))
hi = Vector((-1e9, -1e9, -1e9))
for m in meshes:
    for corner in m.bound_box:
        w = m.matrix_world @ Vector(corner)
        for i in range(3):
            lo[i] = min(lo[i], w[i])
            hi[i] = max(hi[i], w[i])
centre = (lo + hi) / 2
height = hi.z - lo.z
print(f"[render] bbox {tuple(round(v,1) for v in lo)} .. {tuple(round(v,1) for v in hi)}  height={height:.1f}")

scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.display.render_aa = "FXAA"
scene.render.resolution_x = 700
scene.render.resolution_y = 700
scene.render.film_transparent = False
scene.world = bpy.data.worlds.new("W") if scene.world is None else scene.world

cam_data = bpy.data.cameras.new("Cam")
cam_data.type = "ORTHO"
cam_data.ortho_scale = height * 1.15
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

shots = {
    # name: (camera position, look-at)
    "front":  (centre + Vector((0, -height * 2.2, 0)), centre),
    "side":   (centre + Vector((height * 2.2, 0, 0)), centre),
    "threeq": (centre + Vector((height * 1.4, -height * 1.4, height * 0.25)), centre),
    "back":   (centre + Vector((0, height * 2.2, 0)), centre),
}

for name, (pos, target) in shots.items():
    cam.location = pos
    direction = target - pos
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = os.path.join(outdir, f"jinx-{name}.png")
    bpy.ops.render.render(write_still=True)
    print(f"[render] wrote {scene.render.filepath}")

# Close-up on the head and hair.
head_centre = centre + Vector((0, 0, height * 0.30))
cam_data.ortho_scale = height * 0.42
for name, (pos, target) in {
    "hair-front": (head_centre + Vector((0, -height * 0.9, 0)), head_centre),
    "hair-side":  (head_centre + Vector((height * 0.9, 0, 0)), head_centre),
}.items():
    cam.location = pos
    cam.rotation_euler = (target - pos).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = os.path.join(outdir, f"jinx-{name}.png")
    bpy.ops.render.render(write_still=True)
    print(f"[render] wrote {scene.render.filepath}")
