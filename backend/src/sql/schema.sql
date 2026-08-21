-- ============================================
-- ELX Freight Control - Full Schema + Seed
-- ============================================

USE ELXFreight;
GO

-- Locations master table
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Locations')
BEGIN
    CREATE TABLE Locations (
        id INT IDENTITY(1,1) PRIMARY KEY,
        name NVARCHAR(100) NOT NULL UNIQUE,
        code NVARCHAR(20) NULL,
        is_active BIT NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        created_at_utc DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        updated_at_utc DATETIME2 NOT NULL DEFAULT GETUTCDATE()
    );
END
GO

-- Staff (application metadata linked to Entra ID)
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Staff')
BEGIN
    CREATE TABLE Staff (
        id INT IDENTITY(1,1) PRIMARY KEY,
        entra_object_id UNIQUEIDENTIFIER NULL,
        email NVARCHAR(255) NULL,
        display_name NVARCHAR(100) NOT NULL,
        role NVARCHAR(50) NOT NULL DEFAULT 'WarehouseUser',
        is_active BIT NOT NULL DEFAULT 1,
        created_at_utc DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        updated_at_utc DATETIME2 NOT NULL DEFAULT GETUTCDATE()
    );
END
GO

-- Freight Receipts
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'FreightReceipts')
BEGIN
    CREATE TABLE FreightReceipts (
        id BIGINT IDENTITY(1,1) PRIMARY KEY,
        gr_number NVARCHAR(30) NOT NULL UNIQUE,
        supplier NVARCHAR(200) NOT NULL,
        delivery_site NVARCHAR(100) NOT NULL,
        bhp_contractor_name NVARCHAR(200) NULL,
        po_number NVARCHAR(50) NULL,
        other_reference NVARCHAR(100) NULL,
        connote NVARCHAR(100) NULL,
        notes NVARCHAR(MAX) NULL,
        current_status NVARCHAR(50) NOT NULL,
        current_location_id INT NOT NULL,
        received_by_user_id INT NOT NULL,
        received_by_display_name NVARCHAR(100) NOT NULL,
        received_at_utc DATETIME2 NOT NULL,
        created_at_utc DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        updated_at_utc DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        row_version ROWVERSION,
        FOREIGN KEY (current_location_id) REFERENCES Locations(id),
        FOREIGN KEY (received_by_user_id) REFERENCES Staff(id)
    );
END
GO

-- Freight Items
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'FreightItems')
BEGIN
    CREATE TABLE FreightItems (
        id INT IDENTITY(1,1) PRIMARY KEY,
        receipt_id BIGINT NOT NULL,
        item_type NVARCHAR(50) NOT NULL,
        quantity INT NOT NULL CHECK (quantity > 0),
        weight_kg DECIMAL(10,2) NOT NULL CHECK (weight_kg >= 0),
        created_at_utc DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        FOREIGN KEY (receipt_id) REFERENCES FreightReceipts(id) ON DELETE CASCADE
    );
END
GO

-- Lifecycle Events (append-only)
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'LifecycleEvents')
BEGIN
    CREATE TABLE LifecycleEvents (
        id BIGINT IDENTITY(1,1) PRIMARY KEY,
        receipt_id BIGINT NOT NULL,
        event_type NVARCHAR(50) NOT NULL,
        previous_status NVARCHAR(50) NULL,
        new_status NVARCHAR(50) NOT NULL,
        previous_location_id INT NULL,
        new_location_id INT NOT NULL,
        performed_by_user_id INT NOT NULL,
        performed_by_display_name NVARCHAR(100) NOT NULL,
        performed_at_utc DATETIME2 NOT NULL,
        note NVARCHAR(MAX) NULL,
        FOREIGN KEY (receipt_id) REFERENCES FreightReceipts(id)
    );
END
GO

-- Public Receipt Tokens
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PublicReceiptTokens')
BEGIN
    CREATE TABLE PublicReceiptTokens (
        id INT IDENTITY(1,1) PRIMARY KEY,
        receipt_id BIGINT NOT NULL,
        token_hash CHAR(64) NOT NULL UNIQUE,
        created_at_utc DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        revoked_at_utc DATETIME2 NULL,
        expires_at_utc DATETIME2 NULL,
        last_accessed_at_utc DATETIME2 NULL,
        FOREIGN KEY (receipt_id) REFERENCES FreightReceipts(id)
    );
END
GO

-- ============================================
-- SEED DATA
-- ============================================

-- Seed initial locations
MERGE INTO Locations AS target
USING (VALUES
    ('BHP Olympic Dam Cage', 'OD', 1),
    ('BHP Carrapateena Cage', 'CAR', 2),
    ('BHP Prominent Hill Cage', 'PH', 3),
    ('Quarantine / Exception Area', 'QUAR', 4),
    ('General Receiving Area', 'GR', 5),
    ('Ready Dispatch Zone', 'RD', 6),
    ('Loaded / Outbound Bay', 'OB', 7)
) AS source (name, code, sort_order)
ON target.name = source.name
WHEN MATCHED THEN
    UPDATE SET code = source.code, sort_order = source.sort_order, is_active = 1
WHEN NOT MATCHED THEN
    INSERT (name, code, sort_order, is_active)
    VALUES (source.name, source.code, source.sort_order, 1);
GO

-- Seed a default staff member (for local dev)
IF NOT EXISTS (SELECT 1 FROM Staff WHERE display_name = 'ELX Warehouse Admin')
BEGIN
    INSERT INTO Staff (display_name, role, is_active)
    VALUES ('ELX Warehouse Admin', 'Administrator', 1);
END
GO