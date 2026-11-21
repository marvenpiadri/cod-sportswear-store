CREATE UNIQUE INDEX stock_cancel_restore_once_idx ON stock_movements(order_id,variant_id) WHERE movement_type='cancel_restore' AND order_id IS NOT NULL;
