CREATE TABLE notifications (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE, type TEXT NOT NULL DEFAULT 'info', title TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX notifications_read_created_idx ON notifications(is_read,created_at);
