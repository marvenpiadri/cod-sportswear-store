CREATE TABLE IF NOT EXISTS store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO store_settings(key,value) VALUES('price_visible','1') ON CONFLICT(key) DO NOTHING;
