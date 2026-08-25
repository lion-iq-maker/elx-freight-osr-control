const sql = require('mssql');

module.exports = async function (context, req) {
    const connectionString = process.env.SQL_CONNECTION_STRING;
    if (!connectionString) {
        context.res = {
            status: 500,
            body: JSON.stringify({ error: 'SQL connection string missing' })
        };
        return;
    }

    try {
        const pool = await sql.connect(connectionString);

        // 1. Get counts per status
        const statuses = [
            'Goods Received',
            'Location Assigned',
            'SAP Validated',
            'Ready for Dispatch',
            'Dispatched',
            'Delivered',
            'Ready to Invoice'
        ];

        // Build a dynamic query to get counts per status in one go
        const countPromises = statuses.map(status => {
            return pool.request()
                .input('status', sql.NVarChar, status)
                .query('SELECT COUNT(*) AS count FROM FreightReceipts WHERE current_status = @status');
        });

        const countResults = await Promise.all(countPromises);
        const statusCounts = {};
        statuses.forEach((status, i) => {
            statusCounts[status] = countResults[i].recordset[0].count;
        });

        // 2. Get the latest receipts for each status (up to 5 per status)
        const board = [];

        for (const status of statuses) {
            const result = await pool.request()
                .input('status', sql.NVarChar, status)
                .input('limit', sql.Int, 5)
                .query(`
                    SELECT TOP (@limit)
                        r.gr_number AS id,
                        r.supplier,
                        r.po_number AS po,
                        r.delivery_site AS site,
                        r.current_status AS status,
                        l.name AS location,
                        r.updated_at_utc AS updatedAt,
                        (SELECT SUM(quantity) FROM FreightItems WHERE receipt_id = r.id) AS totalQty
                    FROM FreightReceipts r
                    LEFT JOIN Locations l ON r.current_location_id = l.id
                    WHERE r.current_status = @status
                    ORDER BY r.updated_at_utc DESC
                `);

            board.push({
                status: status,
                count: statusCounts[status],
                receipts: result.recordset
            });
        }

        context.res = {
            status: 200,
            body: JSON.stringify({
                statusCounts: statusCounts,
                board: board
            })
        };

    } catch (error) {
        context.log.error('Dashboard error:', error);
        context.res = {
            status: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};