const sql = require('mssql');

module.exports = async function (context, req) {
    const connectionString = process.env.SQL_CONNECTION_STRING;

    if (!connectionString) {
        context.res = { status: 500, body: JSON.stringify({ error: 'SQL connection string missing' }) };
        return;
    }

    try {
        const pool = await sql.connect(connectionString);

        const startDate = String(req.query.startDate || req.query.date || new Date().toISOString().slice(0, 10));
        const endDate = String(req.query.endDate || req.query.date || startDate);
        const site = String(req.query.site || '').trim();
        const status = String(req.query.status || '').trim();

        const request = pool.request()
            .input('startDate', sql.DateTime2, startDate + 'T00:00:00Z')
            .input('endDate', sql.DateTime2, endDate + 'T23:59:59Z');

        let filters = '';
        if (site) {
            filters += ' AND r.delivery_site = @site';
            request.input('site', sql.NVarChar(100), site);
        }
        if (status) {
            filters += ' AND r.current_status = @status';
            request.input('status', sql.NVarChar(50), status);
        }

        const result = await request.query(`
            SELECT
                r.gr_number AS grNumber,
                r.received_at_utc AS receivedAt,
                r.delivery_site AS [to],
                r.supplier AS [from],
                r.po_number AS refNumber,
                fi.item_type AS itemType,
                fi.quantity AS quantity,
                fi.weight_kg AS weightKg,
                fi.length_cm AS lengthCm,
                fi.width_cm AS widthCm,
                fi.height_cm AS heightCm,
                r.other_reference AS ourRefOnPackage,
                r.checked_ref AS checked,
                r.pallet_ref AS pallet,
                (
                    SELECT MIN(le.performed_at_utc)
                    FROM dbo.LifecycleEvents le
                    WHERE le.receipt_id = r.id
                      AND le.new_status = 'Dispatched'
                ) AS dateOut,
                r.date_collected AS dateCollected,
                (
                    SELECT MIN(le.performed_at_utc)
                    FROM dbo.LifecycleEvents le
                    WHERE le.receipt_id = r.id
                      AND le.new_status = 'Delivered'
                ) AS receivedOnSite,
                r.connote AS connote,
                r.pickup_delivery AS pickupDelivery,
                r.address_collection_drop AS addressCollectionDrop,
                r.warehouse_cd_date AS warehouseCdDate,
                r.between_sites AS betweenSites,
                r.back_to_elx AS backToElx,
                r.received_at_utc AS [in],
                (
                    SELECT MIN(le.performed_at_utc)
                    FROM dbo.LifecycleEvents le
                    WHERE le.receipt_id = r.id
                      AND le.new_status = 'Dispatched'
                ) AS [out],
                r.collection_ref AS collection,
                (
                    SELECT MIN(le.performed_at_utc)
                    FROM dbo.LifecycleEvents le
                    WHERE le.receipt_id = r.id
                      AND le.new_status = 'Dispatched'
                ) AS outOfElx,
                r.current_status AS status,
                l.name AS location,
                r.received_by_display_name AS receivedBy
            FROM dbo.FreightReceipts r
            INNER JOIN dbo.FreightItems fi ON fi.receipt_id = r.id
            LEFT JOIN dbo.Locations l ON l.id = r.current_location_id
            WHERE r.received_at_utc >= @startDate
              AND r.received_at_utc <= @endDate
              ${filters}
            ORDER BY r.received_at_utc ASC, r.gr_number ASC, fi.id ASC
        `);

        context.res = {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                startDate,
                endDate,
                rows: result.recordset
            })
        };
    } catch (error) {
        context.log.error('Reports endpoint error:', error);
        context.res = { status: 500, body: JSON.stringify({ error: error.message }) };
    }
};