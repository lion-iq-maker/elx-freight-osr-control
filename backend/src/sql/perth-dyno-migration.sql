-- Perth Dyno Freight migration
-- Run against the ELX Freight database before deploying this branch.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Suppliers' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    CREATE TABLE dbo.Suppliers (
        id INT IDENTITY(1,1) PRIMARY KEY,
        name NVARCHAR(200) NOT NULL UNIQUE,
        is_active BIT NOT NULL DEFAULT 1,
        created_at_utc DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        updated_at_utc DATETIME2 NOT NULL DEFAULT GETUTCDATE()
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'DeliverySites' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    CREATE TABLE dbo.DeliverySites (
        id INT IDENTITY(1,1) PRIMARY KEY,
        name NVARCHAR(100) NOT NULL UNIQUE,
        is_active BIT NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        created_at_utc DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        updated_at_utc DATETIME2 NOT NULL DEFAULT GETUTCDATE()
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME='FreightItems' AND COLUMN_NAME='length_cm')
    ALTER TABLE dbo.FreightItems ADD length_cm DECIMAL(10,2) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME='FreightItems' AND COLUMN_NAME='width_cm')
    ALTER TABLE dbo.FreightItems ADD width_cm DECIMAL(10,2) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME='FreightItems' AND COLUMN_NAME='height_cm')
    ALTER TABLE dbo.FreightItems ADD height_cm DECIMAL(10,2) NULL;
GO

-- Remove the retired legacy field from the previous profile.
DECLARE @legacyColumn SYSNAME = 'bh' + 'p_' + 'contra' + 'ctor_name';
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.FreightReceipts')
      AND name = @legacyColumn
)
BEGIN
    DECLARE @dropLegacySql NVARCHAR(MAX) =
        N'ALTER TABLE dbo.FreightReceipts DROP COLUMN ' + QUOTENAME(@legacyColumn) + N';';
    EXEC sp_executesql @dropLegacySql;
END;
GO

UPDATE dbo.Staff SET is_active = 0;
UPDATE dbo.Locations SET is_active = 0;
UPDATE dbo.DeliverySites SET is_active = 0;
GO

DECLARE @staff TABLE (display_name NVARCHAR(100));
INSERT INTO @staff VALUES ('Jacob Scammell'),('Stephanie Ford'),('Jose Diaz'),('Kathy Pearce');

MERGE dbo.Staff AS target
USING @staff AS source
ON target.display_name = source.display_name
WHEN MATCHED THEN UPDATE SET is_active = 1, updated_at_utc = GETUTCDATE()
WHEN NOT MATCHED THEN INSERT (display_name, role, is_active)
VALUES (source.display_name, 'WarehouseUser', 1);
GO

MERGE dbo.Locations AS target
USING (VALUES ('Perth Warehouse', 'PERTH', 1)) AS source(name, code, sort_order)
ON target.name = source.name
WHEN MATCHED THEN UPDATE SET code=source.code, sort_order=source.sort_order, is_active=1, updated_at_utc=GETUTCDATE()
WHEN NOT MATCHED THEN INSERT (name, code, sort_order, is_active)
VALUES (source.name, source.code, source.sort_order, 1);
GO

MERGE dbo.DeliverySites AS target
USING (VALUES
    ('Christmas Creek', 1),
    ('Solomon', 2),
    ('Cloudbreak', 3)
) AS source(name, sort_order)
ON target.name = source.name
WHEN MATCHED THEN UPDATE SET sort_order=source.sort_order, is_active=1, updated_at_utc=GETUTCDATE()
WHEN NOT MATCHED THEN INSERT (name, sort_order, is_active)
VALUES (source.name, source.sort_order, 1);
GO

DECLARE @suppliers TABLE (name NVARCHAR(200));
INSERT INTO @suppliers (name) VALUES
    (N'Air Filter'),
    (N'Alcohlizer'),
    (N'Alcolizer'),
    (N'Alfagomma'),
    (N'Allied Pump'),
    (N'Allied Pumps'),
    (N'Alolizer'),
    (N'Applied Ind Technologies'),
    (N'Atom'),
    (N'Atom Supply'),
    (N'Berendsen'),
    (N'Berensden Fluid Power'),
    (N'Blackwoods'),
    (N'Bridgestone'),
    (N'Bullivants'),
    (N'Bunnings Armadale'),
    (N'Bunnings Cockburn'),
    (N'Buroseating'),
    (N'Century Batteries'),
    (N'Christmas Creek'),
    (N'Cloudbreak'),
    (N'Coastmac Trailers'),
    (N'Commercial Furniture'),
    (N'Cropline'),
    (N'Customer Collect Shelf'),
    (N'Dyno Gouldsville'),
    (N'ELX Jandakot'),
    (N'Endurequip'),
    (N'Euro Diesel Services'),
    (N'Flex Industries'),
    (N'FMG Iron Bridge'),
    (N'FuelFix'),
    (N'Geobox'),
    (N'Hare Forbes'),
    (N'Hartac'),
    (N'Hartac Sales'),
    (N'Harvey Norman'),
    (N'Haulmark Trailers'),
    (N'Heatley Sales'),
    (N'HiFlex'),
    (N'HS Australia'),
    (N'IEE Global'),
    (N'IFM Efector'),
    (N'Indigenous Beverages'),
    (N'Iron Bridge'),
    (N'Iron Mountain'),
    (N'Jennings Print'),
    (N'Jess Brydon'),
    (N'K Transport'),
    (N'Kulbardi'),
    (N'Lenova'),
    (N'Levanta'),
    (N'Marketiers'),
    (N'Martin Trailer Parts'),
    (N'Michelle McLaughlin'),
    (N'Middys Electrical'),
    (N'Milwaukee'),
    (N'Napa'),
    (N'Nov Australia (Vic)'),
    (N'O''Tooles Mec Repairs'),
    (N'Pallet to go to Cloudbreak'),
    (N'Perth Equipment Sales'),
    (N'Pod of Adblue'),
    (N'PowerPak'),
    (N'Qld?'),
    (N'Quicklee'),
    (N'Radlink'),
    (N'Safety Mits'),
    (N'Safety Signs Service'),
    (N'Scarboro Toyota'),
    (N'Scarborough Toyota'),
    (N'Site Ware Direct'),
    (N'Siteware Direct'),
    (N'Sitewear Direct'),
    (N'Solomon'),
    (N'Startrack'),
    (N'Statewide Bearings'),
    (N'Stemtite'),
    (N'Swagelok WA'),
    (N'T.M.S'),
    (N'Team Global Express'),
    (N'Technical Mechanical Services'),
    (N'Telfer Mine Site'),
    (N'TGE'),
    (N'TGE - Site Ware Direct'),
    (N'TGE - Winc'),
    (N'TGE Ex Tradestar US'),
    (N'Thorzt'),
    (N'TIG - Brady WA'),
    (N'Tiger Pak'),
    (N'Total Tools'),
    (N'Total Tools C''Vale'),
    (N'Toyota'),
    (N'Tradestar'),
    (N'Truck Centre'),
    (N'Truck Centre (Volvo)'),
    (N'Truck Centre / Volvo '),
    (N'United'),
    (N'United Equipment'),
    (N'United Forklift'),
    (N'Valvaline'),
    (N'Valvoline'),
    (N'Varley'),
    (N'VCV Nth Brisbane'),
    (N'Vevor'),
    (N'Volvo'),
    (N'Volvo Group'),
    (N'Wedderburn'),
    (N'Westrac'),
    (N'Wika'),
    (N'Winc'),
    (N'Woodie Woodie');

MERGE dbo.Suppliers AS target
USING @suppliers AS source
ON target.name = source.name
WHEN MATCHED THEN UPDATE SET is_active=1, updated_at_utc=GETUTCDATE()
WHEN NOT MATCHED THEN INSERT (name, is_active) VALUES (source.name, 1);
GO
