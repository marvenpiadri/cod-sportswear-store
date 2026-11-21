CREATE INDEX stock_movements_variant_created_idx ON stock_movements(variant_id,created_at,id);
CREATE INDEX stock_movements_order_idx ON stock_movements(order_id);
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity_type,entity_id,created_at);
