# tools/make_sample.py - 生成一个自包含的示例装配体 GLB
#
# 为什么自己造模型：
# 1. Khronos 官方样例要下 5~17MB，本机网络会中途掐断，不可复现；
# 2. 官方样例多是"一个大 mesh 里塞一堆零件"，零件树/爆炸视图演示不出层级；
# 3. 自建模可以精确控制零件命名、层级、材质与装配关系，
#    让「零件树 / 爆炸视图 / 剖切 / 标注」每个功能都有明确可指的对象。
#
# 产出：一台五轴玩具机械臂
#   base(底板+四脚) → turret(转台) → column(立柱) → shoulder(肩关节)
#   → arm_upper(上臂) → elbow(肘关节) → arm_fore(前臂) → wrist(腕)
#   → palm(掌) → finger_left / finger_right(两指)
# 各段在关节处真实重叠，不是悬空摆放。
#
# 全部几何内嵌在 BIN chunk 里，无任何外链资源。
import json
import math
import os
import struct

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "models")

buffer = bytearray()
bufferViews = []
accessors = []
meshes = []
materials = []
nodes = []


# ----------------------------------------------------------------- 基础工具

def add_buffer(data, target=None):
    while len(buffer) % 4:
        buffer.append(0)
    offset = len(buffer)
    buffer.extend(data)
    bv = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
    if target:
        bv["target"] = target
    bufferViews.append(bv)
    return len(bufferViews) - 1


def add_accessor(bv, comp_type, count, type_, minv=None, maxv=None):
    acc = {"bufferView": bv, "componentType": comp_type, "count": count, "type": type_}
    if minv is not None:
        acc["min"] = minv
        acc["max"] = maxv
    accessors.append(acc)
    return len(accessors) - 1


def _emit(positions, normals, indices, color, name):
    pos_data = b"".join(struct.pack("<3f", *p) for p in positions)
    nrm_data = b"".join(struct.pack("<3f", *n) for n in normals)
    idx_data = b"".join(struct.pack("<H", i) for i in indices)

    bv_pos = add_buffer(pos_data, 34962)
    bv_nrm = add_buffer(nrm_data, 34962)
    bv_idx = add_buffer(idx_data, 34963)

    xs = [p[0] for p in positions]
    ys = [p[1] for p in positions]
    zs = [p[2] for p in positions]

    a_pos = add_accessor(
        bv_pos, 5126, len(positions), "VEC3",
        [min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)],
    )
    a_nrm = add_accessor(bv_nrm, 5126, len(normals), "VEC3")
    a_idx = add_accessor(bv_idx, 5123, len(indices), "SCALAR")

    meshes.append({
        "name": name,
        "primitives": [{
            "attributes": {"POSITION": a_pos, "NORMAL": a_nrm},
            "indices": a_idx,
            "material": color,
        }],
    })
    return len(meshes) - 1


def box(w, h, d, color, name, center=(0, 0, 0)):
    """轴对齐长方体，可按 center 偏移（便于让零件在关节处重叠）"""
    hx, hy, hz = w / 2, h / 2, d / 2
    cx, cy, cz = center
    positions, normals, indices = [], [], []
    faces = [
        ((0, 0, 1), [(-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]),
        ((0, 0, -1), [(hx, -hy, -hz), (-hx, -hy, -hz), (-hx, hy, -hz), (hx, hy, -hz)]),
        ((1, 0, 0), [(hx, -hy, hz), (hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz)]),
        ((-1, 0, 0), [(-hx, -hy, -hz), (-hx, -hy, hz), (-hx, hy, hz), (-hx, hy, -hz)]),
        ((0, 1, 0), [(-hx, hy, hz), (hx, hy, hz), (hx, hy, -hz), (-hx, hy, -hz)]),
        ((0, -1, 0), [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz), (-hx, -hy, hz)]),
    ]
    for n, verts in faces:
        base = len(positions)
        for v in verts:
            positions.append((v[0] + cx, v[1] + cy, v[2] + cz))
            normals.append(n)
        indices += [base, base + 1, base + 2, base, base + 2, base + 3]
    return _emit(positions, normals, indices, color, name)


def cylinder(r, h, seg, color, name, center=(0, 0, 0)):
    """沿 Y 轴的圆柱（含上下盖）"""
    cx, cy, cz = center
    positions, normals, indices = [], [], []

    for i in range(seg + 1):
        a = 2 * math.pi * i / seg
        x, z = r * math.cos(a), r * math.sin(a)
        positions += [(x, -h / 2, z), (x, h / 2, z)]
        normals += [(math.cos(a), 0, math.sin(a))] * 2
    for i in range(seg):
        b = i * 2
        indices += [b, b + 1, b + 2, b + 1, b + 3, b + 2]

    for sign, y in ((1, h / 2), (-1, -h / 2)):
        c = len(positions)
        positions.append((0, y, 0))
        normals.append((0, sign, 0))
        ring = len(positions)
        for i in range(seg):
            a = 2 * math.pi * i / seg
            positions.append((r * math.cos(a), y, r * math.sin(a)))
            normals.append((0, sign, 0))
        for i in range(seg):
            i2 = (i + 1) % seg
            if sign > 0:
                indices += [c, ring + i, ring + i2]
            else:
                indices += [c, ring + i2, ring + i]

    positions = [(p[0] + cx, p[1] + cy, p[2] + cz) for p in positions]
    return _emit(positions, normals, indices, color, name)


def add_material(name, rgb, metallic, rough):
    materials.append({
        "name": name,
        "pbrMetallicRoughness": {
            "baseColorFactor": [*rgb, 1.0],
            "metallicFactor": metallic,
            "roughnessFactor": rough,
        },
    })
    return len(materials) - 1


def node(name, mesh=None, translation=None, children=None, rotation=None):
    n = {"name": name}
    if mesh is not None:
        n["mesh"] = mesh
    if translation:
        n["translation"] = [round(v, 6) for v in translation]
    if rotation:
        n["rotation"] = [round(v, 6) for v in rotation]
    if children:
        n["children"] = list(children)
    nodes.append(n)
    return len(nodes) - 1


def qz(deg):
    """绕 Z 轴旋转的 quaternion [x,y,z,w]"""
    half = math.radians(deg) / 2
    return [0.0, 0.0, math.sin(half), math.cos(half)]


# ----------------------------------------------------------------- 材质

m_body = add_material("body_orange", [0.87, 0.42, 0.12], 0.10, 0.55)
m_steel = add_material("joint_steel", [0.66, 0.69, 0.73], 0.85, 0.28)
m_dark = add_material("rubber_dark", [0.11, 0.12, 0.14], 0.05, 0.88)
m_accent = add_material("accent_teal", [0.13, 0.55, 0.58], 0.30, 0.40)

# ----------------------------------------------------------------- 几何
# 关键：每个零件在"父节点的关节原点"处与父件重叠，避免悬空。

mesh_base = box(1.72, 0.24, 1.34, m_body, "base_plate")
mesh_foot = cylinder(0.17, 0.34, 18, m_dark, "foot")
mesh_turret = cylinder(0.56, 0.42, 26, m_steel, "turret")
mesh_column = cylinder(0.21, 0.74, 20, m_body, "column")
mesh_joint = cylinder(0.19, 0.40, 18, m_steel, "joint")
mesh_arm = box(0.24, 1.16, 0.30, m_body, "arm_upper_shell", center=(0, 0.55, 0))
mesh_fore = box(0.18, 0.94, 0.24, m_accent, "arm_fore_shell", center=(0, 0.45, 0))
mesh_wrist = cylinder(0.12, 0.22, 16, m_steel, "wrist")
mesh_palm = box(0.19, 0.15, 0.24, m_dark, "palm")
mesh_finger = box(0.07, 0.30, 0.10, m_dark, "finger", center=(0, 0.15, 0))
mesh_sensor = cylinder(0.075, 0.10, 14, m_accent, "sensor")

# ----------------------------------------------------------------- 层级
# 自底向上构造：先建叶子，再逐层把 children 一次性传进去。

finger_l = node("finger_left", mesh_finger, [-0.052, 0.0, 0])
finger_r = node("finger_right", mesh_finger, [0.052, 0.0, 0])
palm = node("palm", mesh_palm, [0, 0.09, 0], children=[finger_l, finger_r])
wrist = node("wrist", mesh_wrist, [0, 0.02, 0], children=[palm])

# 前臂：挂在肘关节原点，向 +Y 延伸
arm_fore = node("arm_fore", mesh_fore, [0, 0, 0], children=[wrist])
# 腕在前臂末端
nodes[wrist]["translation"] = [0, 0.84, 0]

# 肘关节：相对肩坐标系旋转 +72°（让前臂往回折）
elbow = node("joint_elbow", mesh_joint, [0, 1.08, 0], children=[arm_fore], rotation=qz(72))

# 上臂：挂在肩原点，向 +Y 延伸
arm_upper = node("arm_upper", mesh_arm, [0, 0, 0], children=[elbow])

# 肩关节：相对立柱倾斜 -34°
shoulder = node("joint_shoulder", mesh_joint, [0, 0.70, 0], children=[arm_upper], rotation=qz(-34))

# 立柱：顶端挂肩
column = node("column", mesh_column, [0, 0.37, 0], children=[shoulder])
sensor = node("sensor", mesh_sensor, [0.20, 0.10, 0.30])

# 转台：顶面挂立柱，侧面挂传感器
turret = node("turret", mesh_turret, [0, 0.21, 0], children=[column, sensor])

# 四脚
foot_ids = [
    node("foot_fl", mesh_foot, [-0.68, 0.02, 0.50]),
    node("foot_fr", mesh_foot, [0.68, 0.02, 0.50]),
    node("foot_bl", mesh_foot, [-0.68, 0.02, -0.50]),
    node("foot_br", mesh_foot, [0.68, 0.02, -0.50]),
]

# 底板：顶面挂转台
base = node("base", mesh_base, [0, 0.12, 0], children=[turret, *foot_ids])

scene_nodes = [base]

# ----------------------------------------------------------------- 组装 GLB
gltf = {
    "asset": {
        "version": "2.0",
        "generator": "glTF Studio sample generator (tools/make_sample.py)",
        "extras": {
            "title": "Toy Robotic Arm",
            "author": "glTF Studio",
            "license": "CC0-1.0",
        },
    },
    "scene": 0,
    "scenes": [{"nodes": scene_nodes, "name": "RoboticArm"}],
    "nodes": nodes,
    "meshes": meshes,
    "materials": materials,
    "accessors": accessors,
    "bufferViews": bufferViews,
    "buffers": [{"byteLength": len(buffer)}],
}

json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
while len(json_bytes) % 4:
    json_bytes += b" "

bin_bytes = bytes(buffer)
while len(bin_bytes) % 4:
    bin_bytes += b"\x00"

total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
glb = bytearray()
glb += b"glTF"
glb += struct.pack("<I", 2)
glb += struct.pack("<I", total)
glb += struct.pack("<I", len(json_bytes))
glb += b"JSON"
glb += json_bytes
glb += struct.pack("<I", len(bin_bytes))
glb += b"BIN\x00"
glb += bin_bytes

os.makedirs(OUT, exist_ok=True)
path = os.path.join(OUT, "RoboticArm.glb")
with open(path, "wb") as f:
    f.write(glb)

print(
    f"wrote {path}  {len(glb):,} bytes  "
    f"nodes={len(nodes)} meshes={len(meshes)} materials={len(materials)}"
)
