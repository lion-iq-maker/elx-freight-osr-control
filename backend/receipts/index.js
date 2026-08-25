const sql = require('mssql');
const crypto = require('crypto');

module.exports = async function (context, req) {
    const connectionString = process.env.SQL_CONNECTION_STRING;
    if (!connectionString) {
        context.res = {
            status: 500,
            body: JSON.stringify({ error: 'SQL connection string missing' })
        };
        return;
    }

    // --- GET: list receipts or single receipt with events ---
    if (req.method === 'GET') {
        return handleGet(context, req, connectionString);
    }

    // --- POST: transition (update status/location) ---
    if (req.method === 'POST' && req.params && req.params.action === 'transition') {
        return handleTransition(context, req, connectionString);
    }

    // --- POST: create a new receipt ---
    if (req.method === 'POST') {
        return handlePost(context, req, connectionString);
    }

    context.res = {
        status: 405,
        body: JSON.stringify({ error: 'Method not allowed' })
    };
};

// ========== HANDLE GET ==========
async function handleGet(context, req, connectionString) {
    try {
        const pool = await sql.connect(connectionString);
        const grNumber = req.params.grNumber;

        // --- If grNumber is provided, return that specific receipt with timeline ---
        if (grNumber) {
            // 1. Get receipt details
            const receiptResult = await pool.request()
                .input('grNumber', sql.NVarChar, grNumber)
                .query(`
                    SELECT
                        r.id,
                        r.gr_number AS grNumber,
                        r.supplier,
                        r.delivery_site AS site,
                        r.po_number AS po,
                        r.current_status AS status,
                        l.name AS location,
                        r.received_by_display_name AS receivedBy,
                        r.received_at_utc AS receivedAt,
                        r.updated_at_utc AS updatedAt,
                        r.notes,
                        (
                            SELECT STRING_AGG(CONCAT(item_type, ' x', quantity, ' (', weight_kg, ' kg)'), ', ')
                            FROM FreightItems fi
                            WHERE fi.receipt_id = r.id
                        ) AS itemsSummary,
                        (
                            SELECT SUM(quantity)
                            FROM FreightItems fi
                            WHERE fi.receipt_id = r.id
                        ) AS totalQty,
                        (
                            SELECT SUM(weight_kg)
                            FROM FreightItems fi
                            WHERE fi.receipt_id = r.id
                        ) AS totalWeight
                    FROM FreightReceipts r
                    LEFT JOIN Locations l ON r.current_location_id = l.id
                    WHERE r.gr_number = @grNumber
                `);

            if (receiptResult.recordset.length === 0) {
                context.res = {
                    status: 404,
                    body: JSON.stringify({ error: 'Receipt not found' })
                };
                return;
            }
            const receipt = receiptResult.recordset[0];

            // 2. Get lifecycle events for this receipt
            const eventsResult = await pool.request()
                .input('receiptId', sql.BigInt, receipt.id)
                .query(`
                    SELECT
                        event_type AS event,
                        previous_status,
                        new_status AS status,
                        performed_by_display_name AS [user],
                        performed_at_utc AS timestamp,
                        note,
                        L.name AS location
                    FROM LifecycleEvents le
                    LEFT JOIN Locations L ON le.new_location_id = L.id
                    WHERE le.receipt_id = @receiptId
                    ORDER BY le.performed_at_utc ASC
                `);

            receipt.events = eventsResult.recordset;

            context.res = {
                status: 200,
                body: JSON.stringify(receipt)
            };
            return;
        }

        // --- Otherwise, return a paginated list of all receipts (for timeline list) ---
        const search = req.query.search || '';
        const status = req.query.status || '';
        const locationId = req.query.locationId || '';
        const startDateParam = req.query.startDate || req.query.date || new Date().toISOString().slice(0, 10);
        const endDateParam = req.query.endDate || req.query.date || new Date().toISOString().slice(0, 10);
        const startDate = startDateParam + 'T00:00:00Z';
        const endDate = endDateParam + 'T23:59:59Z';
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 100;
        const offset = (page - 1) * pageSize;

        let baseQuery = `
            SELECT
                r.gr_number AS id,
                r.supplier,
                r.current_status AS status,
                r.updated_at_utc AS updatedAt,
                (SELECT SUM(quantity) FROM FreightItems WHERE receipt_id = r.id) AS totalQty
            FROM FreightReceipts r
            WHERE 1=1
        `;

        const conditions = [];
        const params = [];

        if (search) {
            conditions.push(`(
                r.gr_number LIKE @search
                OR r.supplier LIKE @search
                OR r.po_number LIKE @search
                OR r.delivery_site LIKE @search
                OR r.connote LIKE @search
                OR r.other_reference LIKE @search
            )`);
            params.push({ name: 'search', value: `%${search}%`, type: sql.NVarChar });
        }

        if (status) {
            conditions.push(`r.current_status = @status`);
            params.push({ name: 'status', value: status, type: sql.NVarChar });
        }

        if (locationId) {
            conditions.push(`r.current_location_id = @locationId`);
            params.push({ name: 'locationId', value: parseInt(locationId), type: sql.Int });
        }

        // Date range filter
        conditions.push(`r.received_at_utc BETWEEN @startDate AND @endDate`);
        params.push({ name: 'startDate', value: startDate, type: sql.DateTime2 });
        params.push({ name: 'endDate', value: endDate, type: sql.DateTime2 });

        if (conditions.length > 0) {
            baseQuery += ' AND ' + conditions.join(' AND ');
        }

        const orderBy = `ORDER BY r.updated_at_utc DESC OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`;
        const query = baseQuery + ' ' + orderBy;

        const request = pool.request();
        for (const p of params) {
            request.input(p.name, p.type, p.value);
        }
        const result = await request.query(query);

        // Total count
        let countQuery = `
            SELECT COUNT(*) AS total
            FROM FreightReceipts r
            WHERE 1=1
        `;
        if (conditions.length > 0) {
            countQuery += ' AND ' + conditions.join(' AND ');
        }
        const countRequest = pool.request();
        for (const p of params) {
            countRequest.input(p.name, p.type, p.value);
        }
        const countResult = await countRequest.query(countQuery);
        const total = countResult.recordset[0].total;

        context.res = {
            status: 200,
            body: JSON.stringify({
                records: result.recordset,
                total: total,
                page: page,
                pageSize: pageSize,
                totalPages: Math.ceil(total / pageSize)
            })
        };

    } catch (error) {
        context.log.error('Error fetching receipts:', error);
        context.res = {
            status: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
}

// ========== HANDLE TRANSITION ==========
async function handleTransition(context, req, connectionString) {
    // ... (unchanged, keep as before)
}

// ========== HANDLE POST ==========
async function handlePost(context, req, connectionString) {
    // ... (unchanged, keep as before)
}
