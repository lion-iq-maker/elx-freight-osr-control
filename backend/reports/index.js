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

        const startDateParam = req.query.startDate || new Date().toISOString().slice(0, 10);
        const endDateParam = req.query.endDate || req.query.date || new Date().toISOString().slice(0, 10);
        const startDate = startDateParam + 'T00:00:00Z';
        const endDate = endDateParam + 'T23:59:59Z';

        const sites = ['BHP Olympic Dam', 'BHP Carrapateena', 'BHP Prominent Hill', 'Other / Unknown'];
        const results = [];

        for (const site of sites) {
            const result = await pool.request()
                .input('site', sql.NVarChar, site)
                .input('startDate', sql.DateTime2, startDate)
                .input('endDate', sql.DateTime2, endDate)
                .query(`
                    SELECT
                        COUNT(DISTINCT r.id) AS totalRecords,
                        ISNULL(SUM(fi.quantity), 0) AS totalQty,
                        ISNULL(SUM(fi.weight_kg), 0) AS totalWeight,
                        COUNT(CASE WHEN r.current_status IN ('Dispatched','Delivered','Ready to Invoice') THEN 1 END) AS dispatchedPlus,
                        COUNT(CASE WHEN r.current_status = 'Ready to Invoice' THEN 1 END) AS readyToInvoice
                    FROM FreightReceipts r
                    LEFT JOIN FreightItems fi ON fi.receipt_id = r.id
                    WHERE r.delivery_site = @site
                    AND r.received_at_utc BETWEEN @startDate AND @endDate
                `);

            const row = result.recordset[0] || {};
            results.push({
                site: site,
                totalRecords: row.totalRecords || 0,
                totalQty: row.totalQty || 0,
                totalWeight: row.totalWeight || 0,
                dispatchedPlus: row.dispatchedPlus || 0,
                readyToInvoice: row.readyToInvoice || 0
            });
        }

        const overallResult = await pool.request()
            .input('startDate', sql.DateTime2, startDate)
            .input('endDate', sql.DateTime2, endDate)
            .query(`
                SELECT
                    COUNT(DISTINCT r.id) AS totalRecords,
                    ISNULL(SUM(fi.quantity), 0) AS totalQty,
                    ISNULL(SUM(fi.weight_kg), 0) AS totalWeight,
                    COUNT(CASE WHEN r.current_status IN ('Dispatched','Delivered','Ready to Invoice') THEN 1 END) AS dispatchedPlus,
                    COUNT(CASE WHEN r.current_status = 'Ready to Invoice' THEN 1 END) AS readyToInvoice
                FROM FreightReceipts r
                LEFT JOIN FreightItems fi ON fi.receipt_id = r.id
                WHERE r.received_at_utc BETWEEN @startDate AND @endDate
            `);

        const overall = overallResult.recordset[0] || {};

        context.res = {
            status: 200,
            body: JSON.stringify({
                sites: results,
                overall: {
                    totalRecords: overall.totalRecords || 0,
                    totalQty: overall.totalQty || 0,
                    totalWeight: overall.totalWeight || 0,
                    dispatchedPlus: overall.dispatchedPlus || 0,
                    readyToInvoice: overall.readyToInvoice || 0
                },
                startDate: startDateParam,
                endDate: endDateParam
            })
        };

    } catch (error) {
        context.log.error('Reports error:', error);
        context.res = {
            status: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
