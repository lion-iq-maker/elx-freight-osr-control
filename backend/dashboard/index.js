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

        const dateFilter = req.query.date || new Date().toISOString().slice(0, 10);
        const startDate = dateFilter + 'T00:00:00Z';
        const endDate = dateFilter + 'T23:59:59Z';

        const statuses = [
            'Goods Received',
            'Location Assigned',
            'SAP Validated',
            'Ready for Dispatch',
            'Dispatched',
            'Delivered',
            'Ready to Invoice'
        ];

        const countPromises = statuses.map(status => {
            return pool.request()
                .input('status', sql.NVarChar, status)
                .input('startDate', sql.DateTime2, startDate)
                .input('endDate', sql.DateTime2, endDate)
                .query(`
                    SELECT COUNT(*) AS count
                    FROM FreightReceipts
                    WHERE current_status = @status
                    AND received_at_utc BETWEEN @startDate AND @endDate
                `);
        });

        const countResults = await Promise.all(countPromises);
        const statusCounts = {};
        statuses.forEach((status, i) => {
            statusCounts[status] = countResults[i].recordset[0].count;
        });

        const board = [];

        for (const status of statuses) {
            const result = await pool.request()
                .input('status', sql.NVarChar, status)
                .input('startDate', sql.DateTime2, startDate)
                .input('endDate', sql.DateTime2, endDate)
                .query(`
                    SELECT
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
                    AND r.received_at_utc BETWEEN @startDate AND @endDate
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
                board: board,
                date: dateFilter
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
