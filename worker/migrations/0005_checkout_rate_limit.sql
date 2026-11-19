CREATE TABLE order_attempts (
  id INTEGER PRIMARY KEY,
  ip TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX order_attempts_ip_time_idx ON order_attempts(ip, attempted_at);
