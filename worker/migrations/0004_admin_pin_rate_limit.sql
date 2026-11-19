CREATE TABLE admin_pin_attempts (id INTEGER PRIMARY KEY, ip TEXT NOT NULL, attempted_at TEXT NOT NULL);
CREATE INDEX admin_pin_attempts_ip_time_idx ON admin_pin_attempts(ip,attempted_at);
