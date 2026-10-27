-- Remove legacy SAP Validated lifecycle status.
-- Existing SAP Validated receipts advance to Ready for Dispatch.

UPDATE dbo.FreightReceipts
SET current_status = 'Ready for Dispatch',
    updated_at_utc = GETUTCDATE()
WHERE current_status = 'SAP Validated';
GO

UPDATE dbo.LifecycleEvents
SET new_status = 'Ready for Dispatch'
WHERE new_status = 'SAP Validated';
GO

UPDATE dbo.LifecycleEvents
SET previous_status = 'Ready for Dispatch'
WHERE previous_status = 'SAP Validated';
GO

IF EXISTS (
    SELECT 1
    FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID('dbo.FreightReceipts')
      AND name = 'CK_FreightReceipts_Status'
)
BEGIN
    ALTER TABLE dbo.FreightReceipts
        DROP CONSTRAINT CK_FreightReceipts_Status;
END;
GO

ALTER TABLE dbo.FreightReceipts WITH CHECK
ADD CONSTRAINT CK_FreightReceipts_Status
CHECK (current_status IN (
    'Goods Received',
    'Location Assigned',
    'Ready for Dispatch',
    'Dispatched',
    'Delivered',
    'Ready to Invoice',
    'Rejected'
));
GO
