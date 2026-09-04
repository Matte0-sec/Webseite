"""ConnectChat local backend. Start: python server.py"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "connectchat.db"
configured_secret = os.environ.get("CONNECTCHAT_SESSION_SECRET")
SESSION_SECRET = (configured_secret.encode() if configured_secret else secrets.token_bytes(32))
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{3,30}$")
EVENT_CLIENTS, EVENT_LOCK = set(), threading.Lock()

def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")

def database():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection

def initialise_database():
    with database() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS Users (id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL, profile_image TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS Chats (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('direct','group')), group_id INTEGER UNIQUE, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ChatMembers (chat_id INTEGER NOT NULL REFERENCES Chats(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES Users(id) ON DELETE CASCADE, joined_at TEXT NOT NULL, last_read_at TEXT NOT NULL, PRIMARY KEY(chat_id,user_id));
        CREATE TABLE IF NOT EXISTS Messages (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES Chats(id) ON DELETE CASCADE, sender_id INTEGER NOT NULL REFERENCES Users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS Groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', owner_id INTEGER NOT NULL REFERENCES Users(id), chat_id INTEGER NOT NULL UNIQUE REFERENCES Chats(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS GroupMembers (group_id INTEGER NOT NULL REFERENCES Groups(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES Users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('owner','admin','member')), joined_at TEXT NOT NULL, PRIMARY KEY(group_id,user_id));
        CREATE TABLE IF NOT EXISTS JoinRequests (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES Groups(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES Users(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('requested','accepted','declined')), created_at TEXT NOT NULL, decided_at TEXT, UNIQUE(group_id,user_id));
        CREATE INDEX IF NOT EXISTS messages_by_chat ON Messages(chat_id, created_at);
        """)

def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 250000)
    return f"pbkdf2_sha256$250000${salt.hex()}${digest.hex()}"

def password_is_valid(password, stored):
    try:
        algorithm, rounds, salt, expected = stored.split("$")
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(rounds)).hex()
        return algorithm == "pbkdf2_sha256" and hmac.compare_digest(actual, expected)
    except (ValueError, AttributeError):
        return False

def sign_session(user_id):
    signature = hmac.new(SESSION_SECRET, str(user_id).encode(), hashlib.sha256).hexdigest()
    return f"{user_id}.{signature}"

def session_user_id(token):
    try:
        user_id, signature = token.rsplit(".", 1)
        expected = hmac.new(SESSION_SECRET, user_id.encode(), hashlib.sha256).hexdigest()
        return int(user_id) if hmac.compare_digest(signature, expected) else None
    except (ValueError, AttributeError):
        return None

def user_json(row):
    return {"id": row["id"], "username": row["username"], "status": row["status"], "profileImage": row["profile_image"]}

def valid_text(value, minimum, maximum, name):
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
        raise ValueError(f"{name} muss zwischen {minimum} und {maximum} Zeichen haben.")
    return value.strip()

def valid_image(value):
    if not value:
        return ""
    if not isinstance(value, str) or len(value) > 900000 or not re.match(r"^data:image/(png|jpeg|webp);base64,", value):
        raise ValueError("Bitte verwende ein gueltiges PNG-, JPEG- oder WebP-Bild.")
    try:
        base64.b64decode(value.split(",", 1)[1], validate=True)
    except ValueError as error:
        raise ValueError("Das Bild ist ungueltig.") from error
    return value

def publish_refresh():
    disconnected = []
    with EVENT_LOCK:
        for client in EVENT_CLIENTS.copy():
            try:
                client.wfile.write(b"event: refresh\ndata: {}\n\n")
                client.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                disconnected.append(client)
        for client in disconnected:
            EVENT_CLIENTS.discard(client)

class ConnectChatHandler(BaseHTTPRequestHandler):
    server_version = "ConnectChat/1.0"

    def log_message(self, format, *args):
        pass

    def send_json(self, status, payload, headers=None):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def fail(self, status, message):
        self.send_json(status, {"error": message})

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1_000_000:
            raise ValueError("Die Anfrage ist zu gross.")
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as error:
            raise ValueError("Ungueltige Anfrage.") from error

    def current_user(self):
        cookie = SimpleCookie(self.headers.get("Cookie"))
        token = cookie.get("connectchat_session")
        user_id = session_user_id(token.value) if token else None
        if not user_id:
            return None
        with database() as db:
            return user_id if db.execute("SELECT 1 FROM Users WHERE id=?", (user_id,)).fetchone() else None

    def require_user(self):
        user_id = self.current_user()
        if not user_id:
            raise PermissionError("Bitte melde dich an.")
        return user_id

    @staticmethod
    def in_chat(db, chat_id, user_id):
        return db.execute("SELECT 1 FROM ChatMembers WHERE chat_id=? AND user_id=?", (chat_id, user_id)).fetchone()

    @staticmethod
    def member_role(db, group_id, user_id):
        row = db.execute("SELECT role FROM GroupMembers WHERE group_id=? AND user_id=?", (group_id, user_id)).fetchone()
        return row["role"] if row else None

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        parts = [part for part in path.split("/") if part]
        try:
            if path == "/api/events" and method == "GET": return self.events()
            if path == "/api/me" and method == "GET": return self.me()
            if path == "/api/auth/register" and method == "POST": return self.register()
            if path == "/api/auth/login" and method == "POST": return self.login()
            if path == "/api/auth/logout" and method == "POST": return self.logout()
            if path == "/api/profile" and method == "POST": return self.profile()
            if path == "/api/users" and method == "GET": return self.search_users(parse_qs(parsed.query).get("q", [""])[0])
            if path == "/api/chats" and method == "GET": return self.list_chats()
            if path == "/api/chats" and method == "POST": return self.create_chat()
            if len(parts) == 4 and parts[:2] == ["api", "chats"] and parts[3] == "messages": return self.chat_messages(method, int(parts[2]))
            if path == "/api/groups" and method == "GET": return self.list_groups()
            if path == "/api/groups" and method == "POST": return self.create_group()
            if len(parts) == 4 and parts[:2] == ["api", "groups"] and parts[3] == "join" and method == "POST": return self.request_join(int(parts[2]))
            if len(parts) == 4 and parts[:2] == ["api", "groups"] and parts[3] == "messages": return self.group_messages(method, int(parts[2]))
            if len(parts) == 4 and parts[:2] == ["api", "groups"] and parts[3] == "requests" and method == "GET": return self.list_requests(int(parts[2]))
            if len(parts) == 5 and parts[:2] == ["api", "groups"] and parts[3] == "requests" and method == "POST": return self.decide_request(int(parts[2]), int(parts[4]))
            if len(parts) == 4 and parts[:2] == ["api", "groups"] and parts[3] == "members" and method == "GET": return self.list_members(int(parts[2]))
            if len(parts) == 4 and parts[:2] == ["api", "groups"] and parts[3] == "members" and method == "POST": return self.manage_member(int(parts[2]))
            if len(parts) == 3 and parts[:2] == ["api", "groups"] and method == "POST": return self.edit_group(int(parts[2]))
            if len(parts) == 3 and parts[:2] == ["api", "groups"] and method == "DELETE": return self.delete_group(int(parts[2]))
            if method == "GET" and not path.startswith("/api/"): return self.serve_static(path)
            self.fail(404, "Endpunkt nicht gefunden.")
        except PermissionError as error:
            self.fail(403 if self.current_user() else 401, str(error))
        except ValueError as error:
            self.fail(400, str(error))
        except sqlite3.IntegrityError:
            self.fail(409, "Diese Angabe ist bereits vergeben oder nicht erlaubt.")
        except Exception:
            self.fail(500, "Serverfehler. Bitte versuche es erneut.")

    def serve_static(self, path):
        file_name = "index.html" if path in ("", "/") else path.lstrip("/")
        allowed = {"index.html": "text/html", "style.css": "text/css", "script.js": "application/javascript"}
        if file_name not in allowed:
            return self.fail(404, "Datei nicht gefunden.")
        body = (ROOT / file_name).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{allowed[file_name]}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def events(self):
        self.require_user()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(b"retry: 3000\n\n")
        self.wfile.flush()
        with EVENT_LOCK:
            EVENT_CLIENTS.add(self)
        try:
            threading.Event().wait()
        finally:
            with EVENT_LOCK:
                EVENT_CLIENTS.discard(self)

    def me(self):
        user_id = self.require_user()
        with database() as db:
            self.send_json(200, user_json(db.execute("SELECT * FROM Users WHERE id=?", (user_id,)).fetchone()))

    def register(self):
        data = self.read_json()
        username = valid_text(data.get("username", ""), 3, 30, "Der Benutzername")
        password = data.get("password", "")
        status = data.get("status", "").strip()
        if not USERNAME_PATTERN.fullmatch(username): raise ValueError("Der Benutzername darf nur Buchstaben, Zahlen, Punkt, Unterstrich und Bindestrich enthalten.")
        if not isinstance(password, str) or not 8 <= len(password) <= 128: raise ValueError("Das Passwort muss zwischen 8 und 128 Zeichen haben.")
        if len(status) > 120: raise ValueError("Der Status ist zu lang.")
        with database() as db:
            user_id = db.execute("INSERT INTO Users(username,password_hash,status,created_at) VALUES(?,?,?,?)", (username, hash_password(password), status, timestamp())).lastrowid
        self.send_json(201, {"ok": True}, {"Set-Cookie": f"connectchat_session={sign_session(user_id)}; HttpOnly; SameSite=Lax; Path=/"})

    def login(self):
        data = self.read_json()
        with database() as db:
            user = db.execute("SELECT * FROM Users WHERE username=?", (data.get("username", ""),)).fetchone()
        if not user or not password_is_valid(data.get("password", ""), user["password_hash"]):
            raise ValueError("Benutzername oder Passwort ist nicht korrekt.")
        self.send_json(200, {"ok": True}, {"Set-Cookie": f"connectchat_session={sign_session(user['id'])}; HttpOnly; SameSite=Lax; Path=/"})

    def logout(self):
        self.send_json(200, {"ok": True}, {"Set-Cookie": "connectchat_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"})

    def profile(self):
        user_id, data = self.require_user(), self.read_json()
        status = data.get("status", "").strip()
        if len(status) > 120: raise ValueError("Der Status ist zu lang.")
        image = valid_image(data.get("profileImage", ""))
        with database() as db:
            if image: db.execute("UPDATE Users SET status=?,profile_image=? WHERE id=?", (status, image, user_id))
            else: db.execute("UPDATE Users SET status=? WHERE id=?", (status, user_id))
            user = db.execute("SELECT * FROM Users WHERE id=?", (user_id,)).fetchone()
        self.send_json(200, user_json(user)); publish_refresh()

    def search_users(self, query):
        user_id = self.require_user()
        if len(query.strip()) < 2: return self.send_json(200, [])
        with database() as db:
            rows = db.execute("SELECT id,username,status,profile_image FROM Users WHERE id != ? AND username LIKE ? ORDER BY username LIMIT 30", (user_id, f"%{query.strip()}%")).fetchall()
        self.send_json(200, [user_json(row) for row in rows])

    def list_chats(self):
        user_id = self.require_user()
        with database() as db:
            rows = db.execute("""SELECT c.id,u.id user_id,u.username,u.status,u.profile_image,cm.last_read_at,
              (SELECT body FROM Messages WHERE chat_id=c.id ORDER BY id DESC LIMIT 1) body,
              (SELECT created_at FROM Messages WHERE chat_id=c.id ORDER BY id DESC LIMIT 1) sent_at,
              (SELECT sender_id FROM Messages WHERE chat_id=c.id ORDER BY id DESC LIMIT 1) sender_id,
              (SELECT username FROM Users WHERE id=(SELECT sender_id FROM Messages WHERE chat_id=c.id ORDER BY id DESC LIMIT 1)) sender_name,
              (SELECT COUNT(*) FROM Messages m WHERE m.chat_id=c.id AND m.sender_id != ? AND m.created_at > cm.last_read_at) unread
              FROM Chats c JOIN ChatMembers cm ON cm.chat_id=c.id AND cm.user_id=? JOIN ChatMembers other_cm ON other_cm.chat_id=c.id AND other_cm.user_id != ? JOIN Users u ON u.id=other_cm.user_id
              WHERE c.kind='direct' ORDER BY COALESCE(sent_at,c.created_at) DESC""", (user_id, user_id, user_id)).fetchall()
        result = []
        for row in rows:
            result.append({"id": row["id"], "other": {"id": row["user_id"], "username": row["username"], "status": row["status"], "profileImage": row["profile_image"]}, "lastMessage": {"body": row["body"], "createdAt": row["sent_at"], "senderName": row["sender_name"]} if row["body"] else None, "unread": row["unread"]})
        self.send_json(200, result)

    def create_chat(self):
        user_id, data = self.require_user(), self.read_json()
        other_id = data.get("userId")
        if not isinstance(other_id, int) or other_id == user_id: raise ValueError("Bitte waehle eine andere Person.")
        with database() as db:
            if not db.execute("SELECT 1 FROM Users WHERE id=?", (other_id,)).fetchone(): raise ValueError("Person nicht gefunden.")
            existing = db.execute("SELECT c.id FROM Chats c JOIN ChatMembers a ON a.chat_id=c.id AND a.user_id=? JOIN ChatMembers b ON b.chat_id=c.id AND b.user_id=? WHERE c.kind='direct'", (user_id, other_id)).fetchone()
            if existing: return self.send_json(200, {"id": existing["id"]})
            chat_id = db.execute("INSERT INTO Chats(kind,created_at) VALUES('direct',?)", (timestamp(),)).lastrowid
            db.executemany("INSERT INTO ChatMembers(chat_id,user_id,joined_at,last_read_at) VALUES(?,?,?,?)", [(chat_id,user_id,timestamp(),timestamp()), (chat_id,other_id,timestamp(),timestamp())])
        self.send_json(201, {"id": chat_id}); publish_refresh()

    def chat_messages(self, method, chat_id):
        user_id = self.require_user()
        with database() as db:
            if not self.in_chat(db, chat_id, user_id): raise PermissionError("Du hast keinen Zugriff auf diesen Chat.")
            if method == "GET":
                rows = db.execute("SELECT m.id,m.sender_id,m.body,m.created_at,u.username FROM Messages m JOIN Users u ON u.id=m.sender_id WHERE m.chat_id=? ORDER BY m.id", (chat_id,)).fetchall()
                db.execute("UPDATE ChatMembers SET last_read_at=? WHERE chat_id=? AND user_id=?", (timestamp(), chat_id, user_id))
                return self.send_json(200, {"messages": [{"id": r["id"], "senderId": r["sender_id"], "senderName": r["username"], "body": r["body"], "createdAt": r["created_at"]} for r in rows]})
            data = self.read_json()
            body = valid_text(data.get("body", ""), 1, 2000, "Die Nachricht")
            db.execute("INSERT INTO Messages(chat_id,sender_id,body,created_at) VALUES(?,?,?,?)", (chat_id, user_id, body, timestamp()))
        self.send_json(201, {"ok": True}); publish_refresh()

    def list_groups(self):
        user_id = self.require_user()
        with database() as db:
            rows = db.execute("SELECT g.*,gm.role,jr.status request_status FROM Groups g LEFT JOIN GroupMembers gm ON gm.group_id=g.id AND gm.user_id=? LEFT JOIN JoinRequests jr ON jr.group_id=g.id AND jr.user_id=? ORDER BY g.created_at DESC", (user_id,user_id)).fetchall()
        self.send_json(200, [{"id": r["id"], "name": r["name"], "description": r["description"], "image": r["image"], "isMember": bool(r["role"]), "role": r["role"], "requestStatus": r["request_status"]} for r in rows])

    def create_group(self):
        user_id, data = self.require_user(), self.read_json()
        name = valid_text(data.get("name", ""), 3, 80, "Der Gruppenname")
        description, image = data.get("description", "").strip(), valid_image(data.get("image", ""))
        if len(description) > 500: raise ValueError("Die Beschreibung ist zu lang.")
        created = timestamp()
        with database() as db:
            chat_id = db.execute("INSERT INTO Chats(kind,created_at) VALUES('group',?)", (created,)).lastrowid
            group_id = db.execute("INSERT INTO Groups(name,description,image,owner_id,chat_id,created_at) VALUES(?,?,?,?,?,?)", (name,description,image,user_id,chat_id,created)).lastrowid
            db.execute("UPDATE Chats SET group_id=? WHERE id=?", (group_id,chat_id))
            db.execute("INSERT INTO GroupMembers(group_id,user_id,role,joined_at) VALUES(?,?, 'owner', ?)", (group_id,user_id,created))
            db.execute("INSERT INTO ChatMembers(chat_id,user_id,joined_at,last_read_at) VALUES(?,?,?,?)", (chat_id,user_id,created,created))
        self.send_json(201, {"id": group_id}); publish_refresh()

    def request_join(self, group_id):
        user_id = self.require_user()
        with database() as db:
            if not db.execute("SELECT 1 FROM Groups WHERE id=?", (group_id,)).fetchone(): raise ValueError("Gruppe nicht gefunden.")
            if self.member_role(db, group_id, user_id): raise ValueError("Du bist bereits Mitglied.")
            db.execute("INSERT INTO JoinRequests(group_id,user_id,status,created_at,decided_at) VALUES(?,?, 'requested', ?, NULL) ON CONFLICT(group_id,user_id) DO UPDATE SET status='requested',created_at=excluded.created_at,decided_at=NULL", (group_id,user_id,timestamp()))
        self.send_json(201, {"ok": True}); publish_refresh()

    def group_messages(self, method, group_id):
        user_id = self.require_user()
        with database() as db:
            group = db.execute("SELECT chat_id FROM Groups WHERE id=?", (group_id,)).fetchone()
            if not group or not self.member_role(db, group_id, user_id): raise PermissionError("Diese private Gruppe ist nicht zugaenglich.")
        self.chat_messages(method, group["chat_id"])

    def list_requests(self, group_id):
        user_id = self.require_user()
        with database() as db:
            if self.member_role(db,group_id,user_id) not in ("owner","admin"): raise PermissionError("Nur Administratoren duerfen Anfragen sehen.")
            rows = db.execute("SELECT jr.id request_id,jr.created_at,u.id user_id,u.username,u.status,u.profile_image FROM JoinRequests jr JOIN Users u ON u.id=jr.user_id WHERE jr.group_id=? AND jr.status='requested'", (group_id,)).fetchall()
        self.send_json(200, [{"id": r["request_id"], "createdAt": r["created_at"], "user": {"id": r["user_id"], "username": r["username"], "status": r["status"], "profileImage": r["profile_image"]}} for r in rows])

    def decide_request(self, group_id, request_id):
        user_id, data = self.require_user(), self.read_json()
        decision = data.get("decision")
        decision = {"accept": "accepted", "decline": "declined"}.get(decision, decision)
        if decision not in ("accepted", "declined"): raise ValueError("Ungueltige Entscheidung.")
        with database() as db:
            if self.member_role(db,group_id,user_id) not in ("owner","admin"): raise PermissionError("Nur Administratoren duerfen Anfragen bearbeiten.")
            request = db.execute("SELECT user_id FROM JoinRequests WHERE id=? AND group_id=? AND status='requested'", (request_id,group_id)).fetchone()
            if not request: raise ValueError("Anfrage nicht gefunden.")
            db.execute("UPDATE JoinRequests SET status=?,decided_at=? WHERE id=?", (decision,timestamp(),request_id))
            if decision == "accepted":
                chat_id = db.execute("SELECT chat_id FROM Groups WHERE id=?", (group_id,)).fetchone()["chat_id"]
                db.execute("INSERT INTO GroupMembers(group_id,user_id,role,joined_at) VALUES(?,?, 'member', ?)", (group_id,request["user_id"],timestamp()))
                db.execute("INSERT INTO ChatMembers(chat_id,user_id,joined_at,last_read_at) VALUES(?,?,?,?)", (chat_id,request["user_id"],timestamp(),timestamp()))
        self.send_json(200, {"ok": True}); publish_refresh()

    def list_members(self, group_id):
        user_id = self.require_user()
        with database() as db:
            if not self.member_role(db,group_id,user_id): raise PermissionError("Diese private Gruppe ist nicht zugaenglich.")
            rows = db.execute("SELECT u.id,u.username,u.status,u.profile_image,gm.role FROM GroupMembers gm JOIN Users u ON u.id=gm.user_id WHERE gm.group_id=? ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,u.username", (group_id,)).fetchall()
        self.send_json(200, [{**user_json(row), "role":row["role"]} for row in rows])

    def manage_member(self, group_id):
        user_id, data = self.require_user(), self.read_json()
        target, action = data.get("userId"), data.get("action")
        if not isinstance(target,int) or action not in ("remove","admin","member"): raise ValueError("Ungueltige Mitgliederaktion.")
        with database() as db:
            actor_role, target_role = self.member_role(db,group_id,user_id), self.member_role(db,group_id,target)
            if not target_role or target_role == "owner": raise PermissionError("Dieses Mitglied kann nicht bearbeitet werden.")
            if actor_role not in ("owner","admin") or (action != "remove" and actor_role != "owner"): raise PermissionError("Dafuer fehlen die Rechte.")
            if action == "remove":
                chat_id = db.execute("SELECT chat_id FROM Groups WHERE id=?", (group_id,)).fetchone()["chat_id"]
                db.execute("DELETE FROM GroupMembers WHERE group_id=? AND user_id=?", (group_id,target)); db.execute("DELETE FROM ChatMembers WHERE chat_id=? AND user_id=?", (chat_id,target))
            else: db.execute("UPDATE GroupMembers SET role=? WHERE group_id=? AND user_id=?", (action,group_id,target))
        self.send_json(200, {"ok": True}); publish_refresh()

    def edit_group(self, group_id):
        user_id, data = self.require_user(), self.read_json()
        name, description = valid_text(data.get("name", ""),3,80,"Der Gruppenname"), data.get("description", "").strip()
        if len(description)>500: raise ValueError("Die Beschreibung ist zu lang.")
        with database() as db:
            if self.member_role(db,group_id,user_id) not in ("owner","admin"): raise PermissionError("Nur Administratoren duerfen die Gruppe bearbeiten.")
            db.execute("UPDATE Groups SET name=?,description=? WHERE id=?", (name,description,group_id))
        self.send_json(200, {"ok":True}); publish_refresh()

    def delete_group(self, group_id):
        user_id = self.require_user()
        with database() as db:
            if self.member_role(db,group_id,user_id) not in ("owner","admin"): raise PermissionError("Nur Administratoren duerfen die Gruppe loeschen.")
            db.execute("DELETE FROM Groups WHERE id=?", (group_id,))
        self.send_json(200, {"ok":True}); publish_refresh()

if __name__ == "__main__":
    initialise_database()
    server = ThreadingHTTPServer(("127.0.0.1", 8080), ConnectChatHandler)
    print("ConnectChat laeuft auf http://127.0.0.1:8080")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()