"""
Diagnose what is actually inside the exported FBX.

    blender --background --factory-startup --python tools/blender-fbx-inspect.py <fbx>

Checks two things that went wrong on the first attempt:
  - how many ARMATURE objects there are (660 bones read back from a 220-bone
    rig means the armature was duplicated per mesh)
  - whether bone names survived the round trip intact
"""

import sys
import bpy

path = sys.argv[sys.argv.index("--") + 1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=path)

arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
others = [o for o in bpy.data.objects if o.type not in {"ARMATURE", "MESH"}]

print("=== FBX CONTENTS ===")
print(f"armatures : {len(arms)}")
for a in arms:
    print(f"   - {a.name}  bones={len(a.data.bones)}  users={a.data.users}")
print(f"meshes    : {len(meshes)}")
for m in meshes:
    mods = [md.type for md in m.modifiers]
    print(f"   - {m.name}  verts={len(m.data.vertices)}  parent={m.parent.name if m.parent else None}  modifiers={mods}")
print(f"other objs: {len(others)}")
for o in others:
    print(f"   - {o.name} ({o.type})")

names = sorted({b.name for a in arms for b in a.data.bones})
print(f"\ndistinct bone names: {len(names)}")
print("first 25:")
for n in names[:25]:
    print(f"   {n}")

mixamo = [n for n in names if n.lower().startswith("mixamorig")]
print(f"\nmixamorig-prefixed names: {len(mixamo)}")
with_colon = [n for n in names if ":" in n]
print(f"names containing a colon: {len(with_colon)} {with_colon[:5]}")