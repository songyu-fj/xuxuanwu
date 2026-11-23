#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""微课视频反思实验系统 —— Flask + SQLite 单机版。

启动：python3 app.py [端口]
默认地址：http://127.0.0.1:5057
教师账号：admin / admin123（可用环境变量 ADMIN_USERNAME、ADMIN_PASSWORD 覆盖）
"""

import csv
import io
import json
import os
import re
import sqlite3
import subprocess
import threading
import uuid
from datetime import datetime
from functools import wraps

import imageio_ffmpeg
from flask import (Flask, Response, g, jsonify, redirect, request, send_file,
                   send_from_directory, session)
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
VIDEO_DIR = os.path.join(DATA_DIR, "videos")
RAW_DIR = os.path.join(DATA_DIR, "raw")
DB_PATH = os.path.join(DATA_DIR, "app.db")
SECRET_PATH = os.path.join(DATA_DIR, "secret.key")
STATIC_DIR = os.path.join(BASE_DIR, "static")

STAGES = ["片头", "片中", "片尾"]
ROUNDS = {1: "课堂练习", 2: "课后反思"}
FLOWS = {"none": "无 AI", "first": "AI 先介入", "later": "AI 后介入"}
VIDEO_STATUS = {"empty": "未上传", "processing": "处理中", "ready": "已就绪", "failed": "处理失败"}
AI_STATUS = {"locked": "待初稿", "waiting": "等待视频", "generating": "生成中", "ready": "已生成", "failed": "失败"}
CLASSES = [(1, "物理1班"), (2, "物理2班"), (3, "化学1班"), (4, "化学2班")]
DEFAULT_CONFIGS = {1: ("none", 0), 2: ("none", 1), 3: ("later", 1), 4: ("first", 1)}
ALLOWED_VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".wmv", ".flv"}

DEFAULT_SETTINGS = {"fixed_sequence": "1", "survey_pre": "1", "survey_post": "1"}
SCALE_LABELS = {1: "完全不符合", 2: "比较不符合", 3: "一般", 4: "比较符合", 5: "完全符合"}
SURVEY_DEFS = {
    "pre": {
        "name": "实验前问卷",
        "items": [
            ("q1", "我清楚教学反思应该关注哪些方面。"),
            ("q2", "我经常在课后回顾自己的课堂教学。"),
            ("q3", "我会依据课堂中的具体片段来解释自己的判断。"),
            ("q4", "我了解 AI 可以如何帮助我改进教学。"),
            ("q5", "我愿意参考 AI 给出的教学建议。"),
        ],
    },
    "post": {
        "name": "实验后问卷",
        "items": [
            ("q1", "本次任务中的反思帮助我梳理了教学中的问题。"),
            ("q2", "AI 建议帮助我发现了原先没有注意到的细节。"),
            ("q3", "我能区分 AI 建议与自己的判断。"),
            ("q4", "本次任务的操作流程清晰、容易完成。"),
            ("q5", "我愿意在以后的教学中继续使用这种反思方式。"),
        ],
    },
}

for d in (DATA_DIR, VIDEO_DIR, RAW_DIR):
    os.makedirs(d, exist_ok=True)

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024
app.config["JSON_AS_ASCII"] = False
try:
    app.json.ensure_ascii = False
except AttributeError:
    pass


def load_secret():
    if os.path.exists(SECRET_PATH):
        with open(SECRET_PATH, "r", encoding="utf-8") as f:
            return f.read().strip()
    key = uuid.uuid4().hex
    with open(SECRET_PATH, "w", encoding="utf-8") as f:
        f.write(key)
    return key


app.secret_key = load_secret()


# ---------------------------------------------------------------- 数据库

def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def now():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def seconds_between(start, end):
    if not start or not end:
        return None
    try:
        return max(0, int((datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds()))
    except (TypeError, ValueError):
        return None


def fmt_seconds(value):
    if value is None:
        return "—"
    try:
        s = max(0, int(float(value)))
    except (TypeError, ValueError):
        return "—"
    return f"{s // 60:02d}:{s % 60:02d}"


def init_db():
    conn = db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS classes(
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS users(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL CHECK(role IN ('teacher','student')),
          name TEXT NOT NULL,
          student_no TEXT UNIQUE,
          class_id INTEGER REFERENCES classes(id),
          participant_code TEXT UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS configs(
          class_id INTEGER NOT NULL REFERENCES classes(id),
          round_id INTEGER NOT NULL,
          flow TEXT NOT NULL CHECK(flow IN ('none','first','later')),
          scaffold INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(class_id, round_id)
        );
        CREATE TABLE IF NOT EXISTS tasks(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id),
          round_id INTEGER NOT NULL,
          class_id INTEGER NOT NULL REFERENCES classes(id),
          flow TEXT NOT NULL,
          scaffold INTEGER NOT NULL,
          video_status TEXT NOT NULL DEFAULT 'empty',
          video_path TEXT,
          raw_path TEXT,
          video_name TEXT,
          duration REAL,
          status TEXT NOT NULL DEFAULT 'in_progress',
          order_deviation INTEGER NOT NULL DEFAULT 0,
          first_input_at TEXT,
          created_at TEXT NOT NULL,
          submitted_at TEXT,
          UNIQUE(user_id, round_id)
        );
        CREATE TABLE IF NOT EXISTS reflections(
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          stage TEXT NOT NULL,
          draft_text TEXT NOT NULL DEFAULT '',
          draft_version INTEGER NOT NULL DEFAULT 0,
          saved_at TEXT,
          PRIMARY KEY(task_id, stage)
        );
        CREATE TABLE IF NOT EXISTS snapshots(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ai_feedback(
          task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'locked',
          items TEXT,
          requested_at TEXT,
          generated_at TEXT,
          presented_at TEXT
        );
        CREATE TABLE IF NOT EXISTS events(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          detail TEXT,
          position REAL,
          occurred_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings(
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS surveys(
          user_id INTEGER NOT NULL REFERENCES users(id),
          kind TEXT NOT NULL,
          answers TEXT NOT NULL,
          submitted_at TEXT NOT NULL,
          PRIMARY KEY(user_id, kind)
        );
        """
    )
    for cid, cname in CLASSES:
        conn.execute("INSERT OR IGNORE INTO classes(id,name) VALUES(?,?)", (cid, cname))
    for cid, (flow, scaffold) in DEFAULT_CONFIGS.items():
        for rid in ROUNDS:
            conn.execute(
                "INSERT OR IGNORE INTO configs(class_id,round_id,flow,scaffold,updated_at) VALUES(?,?,?,?,?)",
                (cid, rid, flow, scaffold, now()),
            )
    for key, value in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (key, value))
    admin_user = os.environ.get("ADMIN_USERNAME", "admin")
    admin_pass = os.environ.get("ADMIN_PASSWORD", "admin123")
    row = conn.execute("SELECT id FROM users WHERE role='teacher' LIMIT 1").fetchone()
    if not row:
        conn.execute(
            "INSERT INTO users(role,name,student_no,class_id,password_hash,created_at) VALUES('teacher',?,NULL,NULL,?,?)",
            (admin_user, generate_password_hash(admin_pass, method="pbkdf2:sha256"), now()),
        )
    # 兼容旧库：补充被试编号列
    columns = {r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "participant_code" not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN participant_code TEXT")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_participant_code ON users(participant_code)")
    for r in conn.execute(
        "SELECT id FROM users WHERE role='student' AND (participant_code IS NULL OR participant_code='')"
    ).fetchall():
        conn.execute("UPDATE users SET participant_code=? WHERE id=?", (f"P{r['id']:04d}", r["id"]))
    # 上次异常退出遗留的处理中状态，启动时转为可重试的失败状态
    conn.execute("UPDATE tasks SET video_status='failed' WHERE video_status='processing'")
    conn.execute("UPDATE ai_feedback SET status='failed' WHERE status='generating'")
    conn.commit()
    conn.close()


def get_settings(conn):
    values = {r["key"]: r["value"] for r in conn.execute("SELECT key,value FROM settings").fetchall()}
    return {key: values.get(key, default) == "1" for key, default in DEFAULT_SETTINGS.items()}


def survey_items(kind):
    return [{"id": item_id, "text": text} for item_id, text in SURVEY_DEFS[kind]["items"]]


def survey_row(conn, user_id, kind):
    row = conn.execute("SELECT * FROM surveys WHERE user_id=? AND kind=?", (user_id, kind)).fetchone()
    if not row:
        return None
    return {"answers": json.loads(row["answers"]), "submitted_at": row["submitted_at"]}


def tasks_submitted(conn, user_id):
    statuses = {r["round_id"]: r["status"] for r in conn.execute(
        "SELECT round_id,status FROM tasks WHERE user_id=?", (user_id,)).fetchall()}
    return statuses.get(1) == "submitted", statuses.get(2) == "submitted"


def log_event(conn, task_id, type_, detail="", position=None):
    seq = conn.execute("SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE task_id=?", (task_id,)).fetchone()[0]
    conn.execute(
        "INSERT INTO events(task_id,seq,type,detail,position,occurred_at) VALUES(?,?,?,?,?,?)",
        (task_id, seq, type_, detail, position, now()),
    )


def snapshot(conn, task_id, kind, content):
    conn.execute(
        "INSERT INTO snapshots(task_id,kind,content,created_at) VALUES(?,?,?,?)",
        (task_id, kind, json.dumps(content, ensure_ascii=False), now()),
    )


def stages_dict(conn, task_id):
    rows = conn.execute("SELECT stage,draft_text FROM reflections WHERE task_id=?", (task_id,)).fetchall()
    data = {r["stage"]: r["draft_text"] for r in rows}
    return {s: data.get(s, "") for s in STAGES}


def latest_snapshot(conn, task_id, kind):
    row = conn.execute(
        "SELECT content,created_at FROM snapshots WHERE task_id=? AND kind=? ORDER BY id DESC LIMIT 1",
        (task_id, kind),
    ).fetchone()
    if not row:
        return None
    return {"stages": json.loads(row["content"]), "time": row["created_at"]}


# ---------------------------------------------------------------- 鉴权

def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    if getattr(g, "_user", None) and g._user["id"] == uid:
        return g._user
    conn = db()
    row = conn.execute(
        "SELECT u.*, c.name AS class_name FROM users u LEFT JOIN classes c ON c.id=u.class_id WHERE u.id=?",
        (uid,),
    ).fetchone()
    conn.close()
    g._user = row
    return row


def login_required(role=None):
    def wrapper(fn):
        @wraps(fn)
        def inner(*args, **kwargs):
            user = current_user()
            if not user:
                return jsonify({"error": "请先登录"}), 401
            if role and user["role"] != role:
                return jsonify({"error": "没有访问权限"}), 403
            return fn(*args, **kwargs)
        return inner
    return wrapper


@app.before_request
def enforce_student_flow():
    """学生任务接口统一校验：前测问卷与固定任务顺序。"""
    match = re.match(r"^/api/student/task/(\d+)", request.path)
    if not match:
        return None
    user = current_user()
    if not user or user["role"] != "student":
        return None
    round_id = int(match.group(1))
    conn = db()
    settings = get_settings(conn)
    if settings["survey_pre"]:
        done = conn.execute(
            "SELECT 1 FROM surveys WHERE user_id=? AND kind='pre'", (user["id"],)
        ).fetchone()
        if not done:
            conn.close()
            return jsonify({"error": "请先完成实验前问卷"}), 403
    if settings["fixed_sequence"] and round_id == 2:
        first = conn.execute(
            "SELECT status FROM tasks WHERE user_id=? AND round_id=1", (user["id"],)
        ).fetchone()
        if not first or first["status"] != "submitted":
            conn.close()
            return jsonify({"error": "请先完成课堂练习并提交，再进入课后反思"}), 403
    conn.close()
    return None


@app.post("/api/login/student")
def login_student():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    student_no = (body.get("student_no") or "").strip()
    class_id = body.get("class_id")
    if not name or not student_no or not class_id:
        return jsonify({"error": "请填写姓名、学号和班级"}), 400
    conn = db()
    cls = conn.execute("SELECT id,name FROM classes WHERE id=?", (class_id,)).fetchone()
    if not cls:
        conn.close()
        return jsonify({"error": "班级不存在"}), 400
    user = conn.execute("SELECT * FROM users WHERE student_no=? AND role='student'", (student_no,)).fetchone()
    if user:
        if user["name"] != name:
            conn.close()
            return jsonify({"error": "姓名与学号不匹配，请检查后重试"}), 400
        if user["class_id"] != cls["id"]:
            started = conn.execute("SELECT 1 FROM tasks WHERE user_id=? LIMIT 1", (user["id"],)).fetchone()
            if started:
                current = conn.execute("SELECT name FROM classes WHERE id=?", (user["class_id"],)).fetchone()
                conn.close()
                return jsonify({
                    "error": f"该学号已在{current['name'] if current else '原班级'}开始任务，"
                             f"请选择{current['name'] if current else '原班级'}登录；如需调整班级请联系研究者"
                }), 400
            conn.execute("UPDATE users SET class_id=? WHERE id=?", (cls["id"], user["id"]))
        uid = user["id"]
    else:
        cur = conn.execute(
            "INSERT INTO users(role,name,student_no,class_id,password_hash,created_at) VALUES('student',?,?,?,?,?)",
            (name, student_no, cls["id"], generate_password_hash(student_no, method="pbkdf2:sha256"), now()),
        )
        uid = cur.lastrowid
    conn.execute(
        "UPDATE users SET participant_code=? WHERE id=? AND (participant_code IS NULL OR participant_code='')",
        (f"P{uid:04d}", uid),
    )
    conn.commit()
    conn.close()
    session.clear()
    session["uid"] = uid
    return jsonify({"ok": True})


@app.post("/api/login/teacher")
def login_teacher():
    body = request.get_json(silent=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    conn = db()
    user = conn.execute("SELECT * FROM users WHERE role='teacher' AND name=?", (username,)).fetchone()
    conn.close()
    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "账号或密码错误"}), 400
    session.clear()
    session["uid"] = user["id"]
    return jsonify({"ok": True})


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/meta")
def meta():
    conn = db()
    classes = [dict(r) for r in conn.execute("SELECT id,name FROM classes ORDER BY id").fetchall()]
    conn.close()
    return jsonify({
        "classes": classes,
        "rounds": [{"id": k, "name": v} for k, v in ROUNDS.items()],
        "flows": FLOWS,
        "stages": STAGES,
    })


@app.get("/api/me")
def me():
    user = current_user()
    if not user:
        return jsonify({"user": None})
    return jsonify({
        "user": {
            "id": user["id"], "role": user["role"], "name": user["name"],
            "student_no": user["student_no"], "class_id": user["class_id"],
            "class_name": user["class_name"], "participant_code": user["participant_code"],
        }
    })


# ---------------------------------------------------------------- 任务与视频

def config_for(conn, class_id, round_id):
    row = conn.execute("SELECT flow,scaffold FROM configs WHERE class_id=? AND round_id=?", (class_id, round_id)).fetchone()
    if row:
        return row["flow"], row["scaffold"]
    return "none", 0


def get_or_create_task(conn, user, round_id):
    row = conn.execute("SELECT * FROM tasks WHERE user_id=? AND round_id=?", (user["id"], round_id)).fetchone()
    if row:
        return row
    flow, scaffold = config_for(conn, user["class_id"], round_id)
    cur = conn.execute(
        "INSERT INTO tasks(user_id,round_id,class_id,flow,scaffold,video_status,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
        (user["id"], round_id, user["class_id"], flow, scaffold, "empty", "in_progress", now()),
    )
    task_id = cur.lastrowid
    for s in STAGES:
        conn.execute("INSERT INTO reflections(task_id,stage) VALUES(?,?)", (task_id, s))
    conn.execute("INSERT INTO ai_feedback(task_id,status) VALUES(?,?)", (task_id, "locked" if flow == "none" else "waiting"))
    log_event(conn, task_id, "进入任务", f"{ROUNDS[round_id]} · {FLOWS[flow]}")
    conn.commit()
    return conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()


def task_payload(conn, task):
    stages = stages_dict(conn, task["id"])
    ai = conn.execute("SELECT * FROM ai_feedback WHERE task_id=?", (task["id"],)).fetchone()
    initial = latest_snapshot(conn, task["id"], "initial")
    final = latest_snapshot(conn, task["id"], "final")
    rows = conn.execute("SELECT stage,draft_version,saved_at FROM reflections WHERE task_id=?", (task["id"],)).fetchall()
    meta = {r["stage"]: {"version": r["draft_version"], "saved_at": r["saved_at"]} for r in rows}
    return {
        "id": task["id"],
        "round_id": task["round_id"],
        "round_name": ROUNDS[task["round_id"]],
        "flow": task["flow"],
        "scaffold": bool(task["scaffold"]),
        "status": task["status"],
        "video_status": task["video_status"],
        "video_name": task["video_name"],
        "duration": task["duration"],
        "order_deviation": bool(task["order_deviation"]),
        "submitted_at": task["submitted_at"],
        "created_at": task["created_at"],
        "can_retry_video": bool(task["raw_path"] and os.path.exists(task["raw_path"])),
        "fixed_sequence": get_settings(conn)["fixed_sequence"],
        "stages": stages,
        "stage_meta": meta,
        "initial": initial,
        "final": final,
        "ai": {
            "status": ai["status"] if ai else "locked",
            "items": json.loads(ai["items"]) if ai and ai["items"] else [],
            "requested_at": ai["requested_at"] if ai else None,
            "generated_at": ai["generated_at"] if ai else None,
            "presented_at": ai["presented_at"] if ai else None,
        },
    }


@app.get("/api/student/overview")
@login_required("student")
def student_overview():
    user = current_user()
    conn = db()
    settings = get_settings(conn)
    pre = survey_row(conn, user["id"], "pre")
    post = survey_row(conn, user["id"], "post")
    first_submitted, second_submitted = tasks_submitted(conn, user["id"])
    tasks = []
    for rid, rname in ROUNDS.items():
        row = conn.execute("SELECT * FROM tasks WHERE user_id=? AND round_id=?", (user["id"], rid)).fetchone()
        flow, scaffold = config_for(conn, user["class_id"], rid)
        locked, reason = False, ""
        if settings["survey_pre"] and not pre:
            locked, reason = True, "请先完成实验前问卷"
        elif settings["fixed_sequence"] and rid == 2 and not first_submitted:
            locked, reason = True, "请先完成课堂练习并提交"
        if row:
            tasks.append({
                "round_id": rid, "round_name": rname, "exists": True,
                "flow": row["flow"], "scaffold": bool(row["scaffold"]),
                "status": row["status"], "video_status": row["video_status"],
                "submitted_at": row["submitted_at"], "locked": locked, "lock_reason": reason,
            })
        else:
            tasks.append({
                "round_id": rid, "round_name": rname, "exists": False,
                "flow": flow, "scaffold": bool(scaffold),
                "status": "not_started", "video_status": "empty", "submitted_at": None,
                "locked": locked, "lock_reason": reason,
            })
    conn.close()
    return jsonify({
        "tasks": tasks,
        "settings": settings,
        "surveys": {
            "pre": {
                "enabled": settings["survey_pre"], "submitted": bool(pre),
                "submitted_at": pre["submitted_at"] if pre else None,
            },
            "post": {
                "enabled": settings["survey_post"],
                "unlocked": first_submitted and second_submitted,
                "submitted": bool(post),
                "submitted_at": post["submitted_at"] if post else None,
            },
        },
        "user": {
            "name": user["name"], "class_name": user["class_name"],
            "participant_code": user["participant_code"],
        },
    })


@app.get("/api/student/task/<int:round_id>")
@login_required("student")
def student_task(round_id):
    if round_id not in ROUNDS:
        return jsonify({"error": "任务不存在"}), 404
    user = current_user()
    conn = db()
    task = get_or_create_task(conn, user, round_id)
    payload = task_payload(conn, task)
    conn.close()
    return jsonify(payload)


@app.post("/api/student/task/<int:round_id>/video")
@login_required("student")
def upload_video(round_id):
    user = current_user()
    conn = db()
    task = get_or_create_task(conn, user, round_id)
    if task["status"] == "submitted":
        conn.close()
        return jsonify({"error": "本轮任务已提交，不能再更换视频"}), 400
    if task["video_status"] == "processing":
        conn.close()
        return jsonify({"error": "视频正在处理中，请稍候"}), 400
    ai = conn.execute("SELECT status,presented_at FROM ai_feedback WHERE task_id=?", (task["id"],)).fetchone()
    linked = conn.execute("SELECT 1 FROM snapshots WHERE task_id=? AND kind='initial'", (task["id"],)).fetchone()
    if task["video_status"] == "ready" and (linked or (ai and (ai["presented_at"] or ai["status"] in ("generating", "ready")))):
        conn.close()
        return jsonify({"error": "本任务的视频已关联初稿或 AI 反馈，为保持素材一致，不能更换"}), 400
    f = request.files.get("video")
    if not f or not f.filename:
        conn.close()
        return jsonify({"error": "请选择视频文件"}), 400
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ALLOWED_VIDEO_EXT:
        conn.close()
        return jsonify({"error": "不支持的视频格式，请上传 mp4 / mov / webm 等常见格式"}), 400
    raw_name = f"{task['id']}-{uuid.uuid4().hex[:8]}{ext}"
    raw_path = os.path.join(RAW_DIR, raw_name)
    f.save(raw_path)
    conn.execute(
        "UPDATE tasks SET video_status='processing', video_name=?, raw_path=?, video_path=NULL, duration=NULL WHERE id=?",
        (f.filename, raw_path, task["id"]),
    )
    log_event(conn, task["id"], "上传开始", f.filename)
    conn.commit()
    conn.close()
    threading.Thread(target=transcode, args=(task["id"], raw_path), daemon=True).start()
    return jsonify({"ok": True, "video_status": "processing"})


@app.post("/api/student/task/<int:round_id>/video/retry")
@login_required("student")
def retry_video(round_id):
    user = current_user()
    conn = db()
    task = get_or_create_task(conn, user, round_id)
    if task["status"] == "submitted":
        conn.close()
        return jsonify({"error": "本轮任务已提交，不能再处理视频"}), 400
    if task["video_status"] == "processing":
        conn.close()
        return jsonify({"error": "视频正在处理中，请稍候"}), 400
    raw_path = task["raw_path"]
    if not raw_path or not os.path.exists(raw_path):
        conn.close()
        return jsonify({"error": "原始视频已不可用，请重新上传"}), 400
    conn.execute(
        "UPDATE tasks SET video_status='processing', video_path=NULL, duration=NULL WHERE id=?",
        (task["id"],),
    )
    log_event(conn, task["id"], "转码重试", "复用已上传的原始视频")
    conn.commit()
    conn.close()
    threading.Thread(target=transcode, args=(task["id"], raw_path), daemon=True).start()
    return jsonify({"ok": True, "video_status": "processing"})


def ffmpeg_duration(text):
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text or "")
    if not m:
        return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def transcode(task_id, raw_path):
    out_path = os.path.join(VIDEO_DIR, f"{task_id}.mp4")
    cmd = [
        FFMPEG, "-y", "-i", raw_path,
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,"
               "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
        "-c:a", "aac", "-b:a", "96k", "-ac", "2",
        "-movflags", "+faststart", out_path,
    ]
    conn = db()
    should_start_ai = False
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        if proc.returncode != 0 or not os.path.exists(out_path):
            raise RuntimeError((proc.stderr or "ffmpeg 转码失败")[-400:])
        duration = ffmpeg_duration(proc.stderr)
        conn.execute(
            "UPDATE tasks SET video_status='ready', video_path=?, duration=? WHERE id=?",
            (out_path, duration, task_id),
        )
        log_event(conn, task_id, "标准视频就绪", "H.264 / AAC / 720p MP4")
        task = conn.execute("SELECT flow,status FROM tasks WHERE id=?", (task_id,)).fetchone()
        conn.commit()
        should_start_ai = bool(task and task["status"] != "submitted" and task["flow"] == "first")
    except Exception as exc:
        conn.execute("UPDATE tasks SET video_status='failed' WHERE id=?", (task_id,))
        log_event(conn, task_id, "转码失败", str(exc)[:300])
        conn.commit()
    finally:
        conn.close()
    if should_start_ai:
        start_ai(task_id)


@app.get("/media/video/<int:task_id>")
def media_video(task_id):
    user = current_user()
    if not user:
        return jsonify({"error": "请先登录"}), 401
    conn = db()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    conn.close()
    if not task or not task["video_path"]:
        return jsonify({"error": "视频不存在"}), 404
    if user["role"] == "student" and task["user_id"] != user["id"]:
        return jsonify({"error": "没有访问权限"}), 403
    return send_file(task["video_path"], mimetype="video/mp4", conditional=True)


# ---------------------------------------------------------------- 反思、AI、提交

def ai_items(duration):
    d = float(duration or 600)
    return [
        {
            "stage": "片头", "time": int(d * 0.06),
            "title": "片头 · 导入与目标",
            "observation": "片头用生活情境引入主题，能在较短时间内吸引注意；学习目标的表述偏概括。",
            "suggestion": "建议在导入后用一句学生能理解的话点明本节要学会什么，并说明它与已有经验的联系。",
        },
        {
            "stage": "片中", "time": int(d * 0.46),
            "title": "片中 · 讲解与互动",
            "observation": "讲解过程中有提问与示范，环节推进较为连贯；学生独立思考的时间偏短。",
            "suggestion": "建议在关键提问后留出 3 至 5 秒停顿，或增加一道辨析题，让学生先说明理由。",
        },
        {
            "stage": "片尾", "time": int(d * 0.86),
            "title": "片尾 · 总结与延伸",
            "observation": "片尾回扣了本节主要内容，总结较为完整；与学习目标的对应关系可以更明确。",
            "suggestion": "建议用一句话回扣学习目标，并布置一个与生活相关的小任务作为延伸。",
        },
    ]


def start_ai(task_id, delay=2.5):
    conn = db()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not task or task["flow"] == "none" or task["status"] == "submitted":
        conn.close()
        return
    conn.execute(
        "UPDATE ai_feedback SET status='generating', requested_at=?, generated_at=NULL, presented_at=NULL WHERE task_id=?",
        (now(), task_id),
    )
    log_event(conn, task_id, "AI 请求", "按片头 / 片中 / 片尾生成观察与建议")
    conn.commit()
    conn.close()

    def finish():
        c = db()
        try:
            t = c.execute("SELECT duration,status,flow FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not t or t["status"] == "submitted" or t["flow"] == "none":
                return
            c.execute(
                "UPDATE ai_feedback SET status='ready', items=?, generated_at=? WHERE task_id=?",
                (json.dumps(ai_items(t["duration"]), ensure_ascii=False), now(), task_id),
            )
            log_event(c, task_id, "反馈生成完成", "内置模拟反馈 v0.1")
            c.commit()
        finally:
            c.close()

    timer = threading.Timer(delay, finish)
    timer.daemon = True
    timer.start()


@app.put("/api/student/task/<int:round_id>/reflection")
@login_required("student")
def save_reflection(round_id):
    user = current_user()
    body = request.get_json(silent=True) or {}
    stage = body.get("stage")
    text = body.get("text", "")
    if stage not in STAGES:
        return jsonify({"error": "反思阶段无效"}), 400
    conn = db()
    task = get_or_create_task(conn, user, round_id)
    if task["status"] == "submitted":
        conn.close()
        return jsonify({"error": "本轮已提交，无法继续编辑"}), 400
    if len(text) > 20000:
        conn.close()
        return jsonify({"error": "内容过长，请控制在 20000 字以内"}), 400
    if text.strip() and not task["first_input_at"]:
        conn.execute("UPDATE tasks SET first_input_at=? WHERE id=?", (now(), task["id"]))
        log_event(conn, task["id"], "首次非空输入", f"{stage}")
        ai = conn.execute("SELECT status,presented_at FROM ai_feedback WHERE task_id=?", (task["id"],)).fetchone()
        if task["flow"] == "first" and ai and not ai["presented_at"]:
            conn.execute("UPDATE tasks SET order_deviation=1 WHERE id=?", (task["id"],))
            log_event(conn, task["id"], "顺序偏离", "AI 反馈首次呈现前已开始写作")
    conn.execute(
        "UPDATE reflections SET draft_text=?, saved_at=? WHERE task_id=? AND stage=?",
        (text, now(), task["id"], stage),
    )
    conn.commit()
    task = conn.execute("SELECT order_deviation,first_input_at FROM tasks WHERE id=?", (task["id"],)).fetchone()
    conn.close()
    return jsonify({
        "ok": True,
        "saved_at": now(),
        "order_deviation": bool(task["order_deviation"]),
        "first_input_at": task["first_input_at"],
    })


@app.post("/api/student/task/<int:round_id>/save-draft")
@login_required("student")
def save_draft(round_id):
    user = current_user()
    body = request.get_json(silent=True) or {}
    stage = body.get("stage")
    conn = db()
    task = get_or_create_task(conn, user, round_id)
    if task["status"] == "submitted":
        conn.close()
        return jsonify({"error": "本轮已提交"}), 400
    row = conn.execute("SELECT draft_text,draft_version FROM reflections WHERE task_id=? AND stage=?", (task["id"], stage)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "阶段无效"}), 400
    version = row["draft_version"] + 1
    conn.execute(
        "UPDATE reflections SET draft_version=?, saved_at=? WHERE task_id=? AND stage=?",
        (version, now(), task["id"], stage),
    )
    log_event(conn, task["id"], "草稿保存", f"{stage} · v{version}")
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "version": version, "saved_at": now()})


@app.post("/api/student/task/<int:round_id>/initial")
@login_required("student")
def confirm_initial(round_id):
    user = current_user()
    conn = db()
    task = get_or_create_task(conn, user, round_id)
    if task["status"] == "submitted":
        conn.close()
        return jsonify({"error": "本轮已提交"}), 400
    if task["flow"] != "later":
        conn.close()
        return jsonify({"error": "当前流程不需要提交初稿"}), 400
    if conn.execute("SELECT 1 FROM snapshots WHERE task_id=? AND kind='initial'", (task["id"],)).fetchone():
        conn.close()
        return jsonify({"error": "初稿已提交"}), 400
    content = stages_dict(conn, task["id"])
    if not any(v.strip() for v in content.values()):
        conn.close()
        return jsonify({"error": "请先填写反思内容"}), 400
    snapshot(conn, task["id"], "initial", content)
    log_event(conn, task["id"], "初稿提交", "保存接触 AI 反馈前的正文")
    conn.commit()
    conn.close()
    start_ai(task["id"])
    return jsonify({"ok": True})


@app.post("/api/student/task/<int:round_id>/submit")
@login_required("student")
def submit_task(round_id):
    user = current_user()
    conn = db()
    task = get_or_create_task(conn, user, round_id)
    if task["status"] == "submitted":
        conn.close()
        return jsonify({"error": "本轮已提交"}), 400
    if task["video_status"] != "ready":
        conn.close()
        return jsonify({"error": "请先上传视频并等待处理完成"}), 400
    content = stages_dict(conn, task["id"])
    if not any(v.strip() for v in content.values()):
        conn.close()
        return jsonify({"error": "请先填写至少一个阶段的反思内容"}), 400
    ai = conn.execute("SELECT * FROM ai_feedback WHERE task_id=?", (task["id"],)).fetchone()
    if task["flow"] == "later":
        if not conn.execute("SELECT 1 FROM snapshots WHERE task_id=? AND kind='initial'", (task["id"],)).fetchone():
            conn.close()
            return jsonify({"error": "请先提交初稿并查看 AI 反馈"}), 400
        if ai and ai["status"] == "generating":
            conn.close()
            return jsonify({"error": "AI 反馈正在生成，请稍候"}), 400
    if task["flow"] == "first" and ai and ai["status"] in ("waiting", "generating"):
        conn.close()
        return jsonify({"error": "请等待 AI 反馈呈现后再提交"}), 400
    snapshot(conn, task["id"], "final", content)
    conn.execute("UPDATE tasks SET status='submitted', submitted_at=? WHERE id=?", (now(), task["id"]))
    log_event(conn, task["id"], "最终提交", "保存最终稿快照")
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.post("/api/student/task/<int:round_id>/ai/present")
@login_required("student")
def ai_present(round_id):
    user = current_user()
    conn = db()
    task = get_or_create_task(conn, user, round_id)
    row = conn.execute("SELECT * FROM ai_feedback WHERE task_id=?", (task["id"],)).fetchone()
    if row and row["status"] == "ready" and not row["presented_at"]:
        conn.execute("UPDATE ai_feedback SET presented_at=? WHERE task_id=?", (now(), task["id"]))
        log_event(conn, task["id"], "反馈首次呈现", "AI 观察与建议已显示")
        conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.post("/api/student/task/<int:round_id>/ai/retry")
@login_required("student")
def ai_retry(round_id):
    user = current_user()
    conn = db()
    task = get_or_create_task(conn, user, round_id)
    conn.close()
    if task["flow"] == "none":
        return jsonify({"error": "当前任务无 AI 流程"}), 400
    if task["video_status"] != "ready":
        return jsonify({"error": "请等待视频处理完成"}), 400
    start_ai(task["id"])
    return jsonify({"ok": True})


@app.post("/api/student/task/<int:round_id>/event")
@login_required("student")
def student_event(round_id):
    user = current_user()
    body = request.get_json(silent=True) or {}
    type_ = (body.get("type") or "").strip()[:40]
    if not type_:
        return jsonify({"error": "事件类型为空"}), 400
    conn = db()
    task = get_or_create_task(conn, user, round_id)
    log_event(conn, task["id"], type_, (body.get("detail") or "")[:200], body.get("position"))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.get("/api/student/records")
@login_required("student")
def student_records():
    user = current_user()
    conn = db()
    result = []
    for rid, rname in ROUNDS.items():
        task = conn.execute("SELECT * FROM tasks WHERE user_id=? AND round_id=?", (user["id"], rid)).fetchone()
        if not task:
            result.append({"round_id": rid, "round_name": rname, "exists": False})
            continue
        payload = task_payload(conn, task)
        result.append({
            "round_id": rid, "round_name": rname, "exists": True,
            "status": task["status"], "submitted_at": task["submitted_at"],
            "stages": payload["stages"], "stage_meta": payload["stage_meta"],
            "initial": payload["initial"], "final": payload["final"],
            "video_name": task["video_name"],
        })
    conn.close()
    return jsonify({"records": result})


# ---------------------------------------------------------------- 前后测问卷

@app.get("/api/student/surveys")
@login_required("student")
def student_surveys():
    user = current_user()
    conn = db()
    settings = get_settings(conn)
    pre = survey_row(conn, user["id"], "pre")
    post = survey_row(conn, user["id"], "post")
    first_submitted, second_submitted = tasks_submitted(conn, user["id"])
    conn.close()
    return jsonify({
        "settings": settings,
        "items": {"pre": survey_items("pre"), "post": survey_items("post")},
        "scale": {str(k): v for k, v in SCALE_LABELS.items()},
        "pre": {
            "enabled": settings["survey_pre"], "submitted": bool(pre),
            "submitted_at": pre["submitted_at"] if pre else None,
            "answers": pre["answers"] if pre else None,
        },
        "post": {
            "enabled": settings["survey_post"],
            "unlocked": first_submitted and second_submitted,
            "submitted": bool(post),
            "submitted_at": post["submitted_at"] if post else None,
            "answers": post["answers"] if post else None,
        },
    })


@app.post("/api/student/survey/<kind>")
@login_required("student")
def submit_survey(kind):
    if kind not in SURVEY_DEFS:
        return jsonify({"error": "问卷不存在"}), 404
    user = current_user()
    conn = db()
    settings = get_settings(conn)
    if not settings["survey_" + kind]:
        conn.close()
        return jsonify({"error": "该问卷未启用"}), 400
    if survey_row(conn, user["id"], kind):
        conn.close()
        return jsonify({"error": "该问卷已提交，不能重复填写"}), 400
    if kind == "post":
        first_submitted, second_submitted = tasks_submitted(conn, user["id"])
        if not (first_submitted and second_submitted):
            conn.close()
            return jsonify({"error": "请先完成课堂练习和课后反思后再填写实验后问卷"}), 400
    body = request.get_json(silent=True) or {}
    answers = body.get("answers") or {}
    scores = {}
    for item_id, _text in SURVEY_DEFS[kind]["items"]:
        try:
            score = int(answers.get(item_id))
        except (TypeError, ValueError):
            conn.close()
            return jsonify({"error": "请完成所有题目后再提交"}), 400
        if score not in SCALE_LABELS:
            conn.close()
            return jsonify({"error": "题目选项无效"}), 400
        scores[item_id] = score
    comment = (body.get("comment") or "").strip()[:1000] if kind == "post" else ""
    scores["comment"] = comment
    conn.execute(
        "INSERT INTO surveys(user_id,kind,answers,submitted_at) VALUES(?,?,?,?)",
        (user["id"], kind, json.dumps(scores, ensure_ascii=False), now()),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- 教师端

@app.get("/api/teacher/config")
@login_required("teacher")
def get_config():
    conn = db()
    classes = [dict(r) for r in conn.execute("SELECT id,name FROM classes ORDER BY id").fetchall()]
    configs = {}
    for r in conn.execute("SELECT * FROM configs").fetchall():
        configs[f"{r['class_id']}:{r['round_id']}"] = {"flow": r["flow"], "scaffold": bool(r["scaffold"])}
    settings = get_settings(conn)
    conn.close()
    return jsonify({
        "classes": classes,
        "rounds": [{"id": k, "name": v} for k, v in ROUNDS.items()],
        "configs": configs,
        "settings": settings,
    })


@app.put("/api/teacher/config")
@login_required("teacher")
def save_config():
    body = request.get_json(silent=True) or {}
    items = body.get("configs") or []
    if not isinstance(items, list) or not items:
        return jsonify({"error": "配置为空"}), 400
    conn = db()
    for item in items:
        try:
            class_id = int(item.get("class_id"))
            round_id = int(item.get("round_id"))
        except (TypeError, ValueError):
            conn.close()
            return jsonify({"error": "配置参数无效"}), 400
        flow = item.get("flow")
        scaffold = 1 if item.get("scaffold") else 0
        if round_id not in ROUNDS or flow not in FLOWS or class_id not in [c[0] for c in CLASSES]:
            conn.close()
            return jsonify({"error": "配置参数无效"}), 400
        conn.execute(
            "INSERT INTO configs(class_id,round_id,flow,scaffold,updated_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(class_id,round_id) DO UPDATE SET flow=excluded.flow,scaffold=excluded.scaffold,updated_at=excluded.updated_at",
            (class_id, round_id, flow, scaffold, now()),
        )
    settings = body.get("settings") or {}
    if not isinstance(settings, dict):
        conn.close()
        return jsonify({"error": "配置参数无效"}), 400
    for key in DEFAULT_SETTINGS:
        if key in settings:
            conn.execute(
                "INSERT INTO settings(key,value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, "1" if settings[key] else "0"),
            )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


def monitor_filters():
    class_id = request.args.get("class_id", "").strip()
    round_id = request.args.get("round_id", "").strip()
    where, params = [], []
    if class_id.isdigit():
        where.append("t.class_id=?")
        params.append(int(class_id))
    if round_id.isdigit() and int(round_id) in ROUNDS:
        where.append("t.round_id=?")
        params.append(int(round_id))
    return (" WHERE " + " AND ".join(where)) if where else "", params


def monitor_rows(conn):
    where, params = monitor_filters()
    sql = f"""
        SELECT t.*, u.name AS student_name, u.student_no, u.participant_code AS participant_id,
               c.name AS class_name,
               a.status AS ai_status, a.requested_at, a.generated_at, a.presented_at, a.items AS ai_items
        FROM tasks t JOIN users u ON u.id=t.user_id JOIN classes c ON c.id=t.class_id
        LEFT JOIN ai_feedback a ON a.task_id=t.id
        {where} ORDER BY t.created_at DESC
    """
    return conn.execute(sql, params).fetchall()


@app.get("/api/teacher/monitor/tasks")
@login_required("teacher")
def monitor_tasks():
    conn = db()
    rows = monitor_rows(conn)
    class_arg = request.args.get("class_id", "").strip()
    round_arg = request.args.get("round_id", "").strip()
    sql = """SELECT u.id,u.name,u.student_no,u.participant_code,c.id AS class_id,c.name AS class_name
             FROM users u JOIN classes c ON c.id=u.class_id WHERE u.role='student'"""
    params = []
    if class_arg.isdigit():
        sql += " AND c.id=?"
        params.append(int(class_arg))
    sql += " ORDER BY c.id,u.name"
    students = conn.execute(sql, params).fetchall()
    rounds = [int(round_arg)] if round_arg.isdigit() and int(round_arg) in ROUNDS else list(ROUNDS)
    task_by_student = {}
    for r in rows:
        task_by_student.setdefault((r["user_id"], r["round_id"]), r)
    result = []
    for s in students:
        for rid in rounds:
            t = task_by_student.get((s["id"], rid))
            result.append({
                "student_name": s["name"], "student_no": s["student_no"],
                "participant_id": s["participant_code"],
                "class_name": s["class_name"], "round_name": ROUNDS[rid],
                "task_id": t["id"] if t else None,
                "status": t["status"] if t else "not_started",
                "flow": FLOWS.get(t["flow"], "") if t else "",
                "scaffold": bool(t["scaffold"]) if t else None,
                "video_status": t["video_status"] if t else "",
                "submitted_at": t["submitted_at"] if t else None,
                "duration_seconds": seconds_between(t["created_at"], t["submitted_at"]) if t else None,
                "order_deviation": bool(t["order_deviation"]) if t else False,
            })
    conn.close()
    return jsonify({"rows": result})


@app.get("/api/teacher/monitor/versions")
@login_required("teacher")
def monitor_versions():
    conn = db()
    rows = monitor_rows(conn)
    result = []
    for r in rows:
        stages = stages_dict(conn, r["id"])
        draft_meta = {m["stage"]: m["saved_at"] for m in conn.execute(
            "SELECT stage,saved_at FROM reflections WHERE task_id=?", (r["id"],)).fetchall()}
        initial = latest_snapshot(conn, r["id"], "initial")
        final = latest_snapshot(conn, r["id"], "final")
        for stage in STAGES:
            draft = stages.get(stage, "")
            has = draft.strip() or (initial and initial["stages"].get(stage, "").strip()) \
                or (final and final["stages"].get(stage, "").strip())
            if not has:
                continue
            result.append({
                "task_id": r["id"], "student_name": r["student_name"],
                "participant_id": r["participant_id"],
                "class_name": r["class_name"], "round_name": ROUNDS[r["round_id"]],
                "stage": stage,
                "draft_text": draft,
                "draft_saved_at": draft_meta.get(stage),
                "initial_text": (initial["stages"].get(stage) if initial else ""),
                "initial_at": initial["time"] if initial else None,
                "final_text": (final["stages"].get(stage) if final else ""),
                "final_at": final["time"] if final else None,
            })
    conn.close()
    return jsonify({"rows": result})


@app.get("/api/teacher/monitor/feedback")
@login_required("teacher")
def monitor_feedback():
    conn = db()
    rows = monitor_rows(conn)
    result = []
    for r in rows:
        if r["flow"] == "none" or not r["ai_status"]:
            continue
        result.append({
            "task_id": r["id"], "student_name": r["student_name"],
            "participant_id": r["participant_id"],
            "class_name": r["class_name"], "round_name": ROUNDS[r["round_id"]],
            "status": r["ai_status"], "model": "内置模拟", "prompt_version": "v0.1",
            "requested_at": r["requested_at"], "generated_at": r["generated_at"],
            "presented_at": r["presented_at"],
            "items": json.loads(r["ai_items"]) if r["ai_items"] else [],
        })
    conn.close()
    return jsonify({"rows": result})


@app.get("/api/teacher/monitor/surveys")
@login_required("teacher")
def monitor_surveys():
    conn = db()
    class_arg = request.args.get("class_id", "").strip()
    sql = """SELECT u.id,u.name,u.student_no,u.participant_code,c.name AS class_name
             FROM users u JOIN classes c ON c.id=u.class_id WHERE u.role='student'"""
    params = []
    if class_arg.isdigit():
        sql += " AND c.id=?"
        params.append(int(class_arg))
    sql += " ORDER BY u.id"
    students = conn.execute(sql, params).fetchall()
    result = []
    for s in students:
        item = {
            "participant_id": s["participant_code"], "student_name": s["name"],
            "student_no": s["student_no"], "class_name": s["class_name"],
            "pre": None, "post": None,
        }
        for kind in ("pre", "post"):
            row = conn.execute(
                "SELECT answers,submitted_at FROM surveys WHERE user_id=? AND kind=?",
                (s["id"], kind),
            ).fetchone()
            if row:
                item[kind] = {"answers": json.loads(row["answers"]), "submitted_at": row["submitted_at"]}
        result.append(item)
    conn.close()
    return jsonify({
        "rows": result,
        "items": {"pre": survey_items("pre"), "post": survey_items("post")},
        "scale": {str(k): v for k, v in SCALE_LABELS.items()},
    })


@app.get("/api/teacher/monitor/events")
@login_required("teacher")
def monitor_events():
    conn = db()
    where, params = monitor_filters()
    rows = conn.execute(
        f"""SELECT e.*, t.round_id, t.user_id, c.name AS class_name, u.name AS student_name,
                   u.participant_code AS participant_id
            FROM events e JOIN tasks t ON t.id=e.task_id
            JOIN classes c ON c.id=t.class_id JOIN users u ON u.id=t.user_id
            {where} ORDER BY e.occurred_at DESC, e.id DESC LIMIT 800""",
        params,
    ).fetchall()
    conn.close()
    return jsonify({"rows": [{
        "task_id": r["task_id"], "student_name": r["student_name"],
        "participant_id": r["participant_id"], "class_name": r["class_name"],
        "round_name": ROUNDS[r["round_id"]], "seq": r["seq"], "type": r["type"],
        "detail": r["detail"], "position": r["position"], "occurred_at": r["occurred_at"],
    } for r in rows]})


def csv_response(filename, header, rows):
    buf = io.StringIO()
    buf.write("\ufeff")
    writer = csv.writer(buf)
    writer.writerow(header)
    for row in rows:
        writer.writerow(row)
    data = buf.getvalue().encode("utf-8")
    resp = Response(data, mimetype="text/csv; charset=utf-8")
    resp.headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{filename}"
    return resp


def drop_columns(header, data, indexes):
    keep = [i for i in range(len(header)) if i not in indexes]
    return [header[i] for i in keep], [[row[i] for i in keep] for row in data]


@app.get("/api/teacher/export")
@login_required("teacher")
def export_csv():
    kind = request.args.get("type", "tasks")
    anonymous = request.args.get("anonymous") == "1"
    conn = db()
    rows = monitor_rows(conn)
    filename = "tasks.csv"
    if kind == "tasks":
        header = ["participant_id", "task_id", "学生", "学号", "班级", "任务", "AI流程", "反思支架",
                  "视频状态", "任务状态", "提交时间", "用时(秒)", "顺序偏离", "AI状态"]
        data = [[r["participant_id"], r["id"], r["student_name"], r["student_no"],
                 r["class_name"], ROUNDS[r["round_id"]],
                 FLOWS.get(r["flow"], r["flow"]), "开启" if r["scaffold"] else "关闭",
                 VIDEO_STATUS.get(r["video_status"], r["video_status"]),
                 "已提交" if r["status"] == "submitted" else "进行中",
                 r["submitted_at"] or "",
                 seconds_between(r["created_at"], r["submitted_at"]) or "",
                 "是" if r["order_deviation"] else "否",
                 "无 AI" if r["flow"] == "none" else AI_STATUS.get(r["ai_status"], r["ai_status"] or "")]
                for r in rows]
    elif kind == "participants":
        filename = "participants.csv"
        header = ["participant_id", "姓名", "学号", "班级", "课堂练习流程", "课堂练习状态",
                  "课后反思流程", "课后反思状态", "前测状态", "后测状态", "注册时间"]
        sql = """SELECT u.*, c.name AS class_name,
                   (SELECT flow FROM configs WHERE class_id=u.class_id AND round_id=1) AS flow1,
                   (SELECT flow FROM configs WHERE class_id=u.class_id AND round_id=2) AS flow2,
                   (SELECT status FROM tasks WHERE user_id=u.id AND round_id=1) AS status1,
                   (SELECT status FROM tasks WHERE user_id=u.id AND round_id=2) AS status2,
                   (SELECT 1 FROM surveys WHERE user_id=u.id AND kind='pre') AS pre_done,
                   (SELECT 1 FROM surveys WHERE user_id=u.id AND kind='post') AS post_done
                 FROM users u JOIN classes c ON c.id=u.class_id
                 WHERE u.role='student'"""
        params = []
        class_arg = request.args.get("class_id", "").strip()
        if class_arg.isdigit():
            sql += " AND u.class_id=?"
            params.append(int(class_arg))
        sql += " ORDER BY u.id"
        students = conn.execute(sql, params).fetchall()

        def status_label(v):
            return {"submitted": "已提交", "in_progress": "进行中"}.get(v, "未开始")
        data = [[s["participant_code"], s["name"], s["student_no"], s["class_name"],
                 FLOWS.get(s["flow1"], ""), status_label(s["status1"]),
                 FLOWS.get(s["flow2"], ""), status_label(s["status2"]),
                 "已完成" if s["pre_done"] else "未填写",
                 "已完成" if s["post_done"] else "未填写", s["created_at"]]
                for s in students]
    elif kind == "versions":
        filename = "text_versions.csv"
        header = ["participant_id", "task_id", "学生", "班级", "任务", "阶段", "版本", "正文", "字数", "时间"]
        data = []
        for r in rows:
            stages = stages_dict(conn, r["id"])
            initial = latest_snapshot(conn, r["id"], "initial")
            final = latest_snapshot(conn, r["id"], "final")
            for stage in STAGES:
                if stages.get(stage, "").strip():
                    data.append([r["participant_id"], r["id"], r["student_name"], r["class_name"],
                                 ROUNDS[r["round_id"]], stage, "当前草稿", stages[stage],
                                 len(stages[stage].strip()), ""])
                if initial and initial["stages"].get(stage, "").strip():
                    data.append([r["participant_id"], r["id"], r["student_name"], r["class_name"],
                                 ROUNDS[r["round_id"]], stage, "已提交初稿", initial["stages"][stage],
                                 len(initial["stages"][stage].strip()), initial["time"]])
                if final and final["stages"].get(stage, "").strip():
                    data.append([r["participant_id"], r["id"], r["student_name"], r["class_name"],
                                 ROUNDS[r["round_id"]], stage, "最终稿", final["stages"][stage],
                                 len(final["stages"][stage].strip()), final["time"]])
    elif kind == "feedback":
        filename = "ai_feedback.csv"
        header = ["participant_id", "task_id", "学生", "班级", "任务", "状态", "模型", "提示词版本",
                  "请求时间", "生成时间", "首次呈现", "反馈内容"]
        data = []
        for r in rows:
            if r["flow"] == "none" or not r["ai_status"]:
                continue
            items = json.loads(r["ai_items"]) if r["ai_items"] else []
            text = "\n\n".join(f"[{i['stage']}] {i['title']}\n{i['observation']}\n建议：{i['suggestion']}" for i in items)
            data.append([r["participant_id"], r["id"], r["student_name"], r["class_name"],
                         ROUNDS[r["round_id"]], AI_STATUS.get(r["ai_status"], r["ai_status"]),
                         "内置模拟", "v0.1", r["requested_at"] or "",
                         r["generated_at"] or "", r["presented_at"] or "", text])
    elif kind == "surveys":
        filename = "surveys.csv"
        header = ["participant_id", "姓名", "学号", "班级", "问卷", "提交时间",
                  "q1", "q2", "q3", "q4", "q5", "其他想法"]
        data = []
        students = conn.execute(
            "SELECT u.*,c.name AS class_name FROM users u JOIN classes c ON c.id=u.class_id "
            "WHERE u.role='student' ORDER BY u.id"
        ).fetchall()
        class_arg = request.args.get("class_id", "").strip()
        for s in students:
            if class_arg.isdigit() and s["class_id"] != int(class_arg):
                continue
            for skind in ("pre", "post"):
                row = conn.execute(
                    "SELECT answers,submitted_at FROM surveys WHERE user_id=? AND kind=?",
                    (s["id"], skind),
                ).fetchone()
                if not row:
                    continue
                ans = json.loads(row["answers"])
                data.append([s["participant_code"], s["name"], s["student_no"], s["class_name"],
                             SURVEY_DEFS[skind]["name"], row["submitted_at"]] +
                            [ans.get(item_id, "") for item_id, _ in SURVEY_DEFS[skind]["items"]] +
                            [ans.get("comment", "")])
    else:
        filename = "events.csv"
        header = ["participant_id", "task_id", "学生", "班级", "任务", "序号", "事件", "详情", "视频位置", "发生时间"]
        events = conn.execute(
            f"""SELECT e.*, t.round_id, c.name AS class_name, u.name AS student_name,
                       u.participant_code AS participant_id
                FROM events e JOIN tasks t ON t.id=e.task_id
                JOIN classes c ON c.id=t.class_id JOIN users u ON u.id=t.user_id
                {monitor_filters()[0]} ORDER BY e.occurred_at""",
            monitor_filters()[1],
        ).fetchall()
        data = [[e["participant_id"], e["task_id"], e["student_name"], e["class_name"],
                 ROUNDS[e["round_id"]], e["seq"], e["type"], e["detail"] or "",
                 e["position"] if e["position"] is not None else "", e["occurred_at"]]
                for e in events]
    conn.close()
    if anonymous:
        drop = {"tasks": [2, 3], "participants": [1, 2],
                "versions": [2], "feedback": [2], "events": [2], "surveys": [1, 2]}.get(kind, [])
        if drop:
            header, data = drop_columns(header, data, drop)
        filename = filename.replace(".csv", "-anonymous.csv")
    return csv_response(filename, header, data)


@app.get("/api/teacher/task/<int:task_id>/ai")
@login_required("teacher")
def export_task_ai(task_id):
    conn = db()
    row = conn.execute(
        "SELECT t.*,u.name AS student_name,u.student_no,u.participant_code,c.name AS class_name "
        "FROM tasks t JOIN users u ON u.id=t.user_id JOIN classes c ON c.id=t.class_id WHERE t.id=?",
        (task_id,),
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "任务不存在"}), 404
    ai = conn.execute("SELECT * FROM ai_feedback WHERE task_id=?", (task_id,)).fetchone()
    conn.close()
    items = json.loads(ai["items"]) if ai and ai["items"] else []
    lines = [
        f"被试编号：{row['participant_code']} · 任务 {task_id} · {row['class_name']} · {ROUNDS[row['round_id']]}",
        f"流程：{FLOWS[row['flow']]} · 反馈状态：{AI_STATUS.get(ai['status'], ai['status']) if ai else '无'}",
        f"请求时间：{ai['requested_at'] or '—'} · 生成时间：{ai['generated_at'] or '—'} · 首次呈现：{ai['presented_at'] or '—'}" if ai else "",
        "",
    ]
    for item in items:
        lines += [
            f"[{item['stage']}] {item['title']}（{fmt_seconds(item['time'])}）",
            item["observation"],
            f"建议：{item['suggestion']}",
            "",
        ]
    if not items:
        lines.append("（暂无 AI 反馈内容）")
    resp = Response("\n".join(lines).encode("utf-8"), mimetype="text/plain; charset=utf-8")
    resp.headers["Content-Disposition"] = f"attachment; filename=task-{task_id}-ai.txt"
    return resp


@app.get("/api/teacher/task/<int:task_id>/events")
@login_required("teacher")
def export_task_events(task_id):
    conn = db()
    row = conn.execute(
        "SELECT t.*,u.name AS student_name,u.student_no,u.participant_code,c.name AS class_name "
        "FROM tasks t JOIN users u ON u.id=t.user_id JOIN classes c ON c.id=t.class_id WHERE t.id=?",
        (task_id,),
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "任务不存在"}), 404
    events = conn.execute("SELECT * FROM events WHERE task_id=? ORDER BY seq", (task_id,)).fetchall()
    conn.close()
    lines = [
        f"被试编号：{row['participant_code']} · 任务 {task_id} · {row['class_name']} · {ROUNDS[row['round_id']]}",
        f"流程：{FLOWS[row['flow']]} · 状态：{'已提交' if row['status'] == 'submitted' else '进行中'}",
        "",
    ]
    for e in events:
        pos = f" · 视频 {fmt_seconds(e['position'])}" if e["position"] is not None else ""
        detail = f" · {e['detail']}" if e["detail"] else ""
        lines.append(f"#{e['seq']} {e['occurred_at']} · {e['type']}{pos}{detail}")
    if not events:
        lines.append("（暂无行为事件）")
    resp = Response("\n".join(lines).encode("utf-8"), mimetype="text/plain; charset=utf-8")
    resp.headers["Content-Disposition"] = f"attachment; filename=task-{task_id}-events.txt"
    return resp


@app.get("/api/teacher/task/<int:task_id>/text")
@login_required("teacher")
def export_task_text(task_id):
    conn = db()
    row = conn.execute(
        "SELECT t.*,u.name AS student_name,u.student_no,u.participant_code,c.name AS class_name "
        "FROM tasks t JOIN users u ON u.id=t.user_id JOIN classes c ON c.id=t.class_id WHERE t.id=?",
        (task_id,),
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "任务不存在"}), 404
    stages = stages_dict(conn, task_id)
    initial = latest_snapshot(conn, task_id, "initial")
    final = latest_snapshot(conn, task_id, "final")
    conn.close()
    lines = [
        f"被试编号：{row['participant_code']} · 任务 {task_id} · {row['student_name']}（{row['student_no']}） · {row['class_name']}",
        f"任务：{ROUNDS[row['round_id']]} · 流程：{FLOWS[row['flow']]} · 状态：{'已提交' if row['status'] == 'submitted' else '进行中'}",
        "",
    ]
    for stage in STAGES:
        lines.append(f"【{stage}】")
        lines.append("当前草稿：")
        lines.append(stages.get(stage, "") or "（空）")
        if initial:
            lines.append("已提交初稿：")
            lines.append(initial["stages"].get(stage, "") or "（空）")
        if final:
            lines.append("最终稿：")
            lines.append(final["stages"].get(stage, "") or "（空）")
        lines.append("")
    data = "\n".join(lines).encode("utf-8")
    resp = Response(data, mimetype="text/plain; charset=utf-8")
    resp.headers["Content-Disposition"] = f"attachment; filename=task-{task_id}.txt"
    return resp


# ---------------------------------------------------------------- 页面

@app.get("/")
def index():
    user = current_user()
    if user and user["role"] == "teacher":
        return redirect("/teacher")
    return redirect("/student")


@app.get("/student")
def student_page():
    user = current_user()
    if user and user["role"] == "teacher":
        return redirect("/teacher")
    return send_from_directory(STATIC_DIR, "student.html")


@app.get("/teacher")
def teacher_page():
    user = current_user()
    if user and user["role"] == "student":
        return redirect("/student")
    return send_from_directory(STATIC_DIR, "teacher.html")


@app.errorhandler(413)
def too_large(_):
    return jsonify({"error": "文件过大，请上传 500MB 以内的视频"}), 413


if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", "5057"))
    host = os.environ.get("HOST", "127.0.0.1")
    print(f"微课视频反思实验系统已启动：http://{host}:{port}")
    app.run(host=host, port=port, debug=False, threaded=True)
