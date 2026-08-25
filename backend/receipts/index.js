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

    // --- GET: list receipts with item summaries (with date filter) ---
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

// ========== HANDLE GET (with date filter) ==========
async function handleGet(context, req, connectionString) {
    try {
        const pool = await sql.connect(connectionString);

        const search = req.query.search || '';
        const status = req.query.status || '';
        const locationId = req.query.locationId || '';
        const dateFilter = req.query.date || new Date().toISOString().slice(0, 10);
        const startDate = dateFilter + 'T00:00:00Z';
        const endDate = dateFilter + 'T23:59:59Z';
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 50;
        const offset = (page - 1) * pageSize;

        let baseQuery = `
            SELECT
                r.id,
                r.gr_number AS grNumber,
                r.supplier,
                r.delivery_site AS site,
                r.po_number AS po,
                r.current_status AS status,
                l.name AS location,
                r.received_by_display_name AS receivedBy,
                r.updated_at_utc AS updatedAt,
                (
                    SELECT STRING_AGG(CONCAT(item_type, ' x', quantity), ', ')
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

        // Date filter
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
    try {
        const grNumber = req.params.grNumber;
        const body = req.body || {};

        if (!body.targetStatus) {
            context.res = {
                status: 400,
                body: JSON.stringify({ error: 'Missing targetStatus' })
            };
            return;
        }
        if (!body.receivedBy) {
            context.res = {
                status: 400,
                body: JSON.stringify({ error: 'Missing receivedBy (staff name)' })
            };
            return;
        }

        const pool = await sql.connect(connectionString);
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const receiptResult = await transaction.request()
                .input('grNumber', sql.NVarChar, grNumber)
                .query(`
                    SELECT r.id, r.current_status, r.current_location_id, l.name AS locationName
                    FROM FreightReceipts r
                    LEFT JOIN Locations l ON r.current_location_id = l.id
                    WHERE r.gr_number = @grNumber
                `);

            if (receiptResult.recordset.length === 0) {
                throw new Error('Receipt not found');
            }

            const receipt = receiptResult.recordset[0];
            const oldStatus = receipt.current_status;
            const oldLocationId = receipt.current_location_id;
            const oldLocationName = receipt.locationName || 'Unknown';

            let newLocationId = null;
            if (body.location) {
                const locResult = await transaction.request()
                    .input('locationName', sql.NVarChar, body.location)
                    .query(`SELECT id FROM Locations WHERE name = @locationName`);
                if (locResult.recordset.length === 0) {
                    throw new Error(`Location "${body.location}" not found`);
                }
                newLocationId = locResult.recordset[0].id;
            } else {
                newLocationId = oldLocationId;
            }

            const staffResult = await transaction.request()
                .input('displayName', sql.NVarChar, body.receivedBy)
                .query(`SELECT id FROM Staff WHERE display_name = @displayName`);
            if (staffResult.recordset.length === 0) {
                throw new Error(`Staff member "${body.receivedBy}" not found`);
            }
            const userId = staffResult.recordset[0].id;

            const now = new Date().toISOString();
            await transaction.request()
                .input('grNumber', sql.NVarChar, grNumber)
                .input('newStatus', sql.NVarChar, body.targetStatus)
                .input('newLocationId', sql.Int, newLocationId)
                .input('updatedAt', sql.DateTime2, now)
                .query(`
                    UPDATE FreightReceipts
                    SET current_status = @newStatus,
                        current_location_id = @newLocationId,
                        updated_at_utc = @updatedAt
                    WHERE gr_number = @grNumber
                `);

            const eventNote = body.note || `Status: ${oldStatus} → ${body.targetStatus} | Location: ${oldLocationName} → ${body.location || oldLocationName}`;
            await transaction.request()
                .input('receiptId', sql.BigInt, receipt.id)
                .input('eventType', sql.NVarChar, 'STATUS_CHANGE')
                .input('oldStatus', sql.NVarChar, oldStatus)
                .input('newStatus', sql.NVarChar, body.targetStatus)
                .input('oldLocationId', sql.Int, oldLocationId)
                .input('newLocationId', sql.Int, newLocationId)
                .input('userId', sql.Int, userId)
                .input('displayName', sql.NVarChar, body.receivedBy)
                .input('performedAt', sql.DateTime2, now)
                .input('note', sql.NVarChar, eventNote)
                .query(`
                    INSERT INTO LifecycleEvents (
                        receipt_id, event_type,
                        previous_status, new_status,
                        previous_location_id, new_location_id,
                        performed_by_user_id, performed_by_display_name,
                        performed_at_utc, note
                    )
                    VALUES (
                        @receiptId, @eventType,
                        @oldStatus, @newStatus,
                        @oldLocationId, @newLocationId,
                        @userId, @displayName,
                        @performedAt, @note
                    )
                `);

            await transaction.commit();

            context.res = {
                status: 200,
                body: JSON.stringify({
                    success: true,
                    grNumber: grNumber,
                    newStatus: body.targetStatus,
                    newLocation: body.location || oldLocationName,
                    updatedAt: now
                })
            };

        } catch (error) {
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        context.log.error('Transition error:', error);
        context.res = {
            status: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
}

// ========== HANDLE POST (Create Receipt) ==========
async function handlePost(context, req, connectionString) {
    const body = req.body || {};
    const required = ['supplier', 'site', 'receivedBy'];
    const missing = required.filter(f => !body[f]);
    if (missing.length) {
        context.res = {
            status: 400,
            body: JSON.stringify({ error: `Missing required fields: ${missing.join(', ')}` })
        };
        return;
    }

    if (!Array.isArray(body.items) || body.items.length === 0) {
        context.res = {
            status: 400,
            body: JSON.stringify({ error: 'At least one freight item is required' })
        };
        return;
    }

    try {
        const pool = await sql.connect(connectionString);
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const grDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const countResult = await transaction.request().query(
                `SELECT COUNT(*) AS count FROM FreightReceipts WHERE gr_number LIKE 'ELX-GR-${grDate}-%'`
            );
            const sequence = String(Number(countResult.recordset[0].count) + 1).padStart(5, '0');
            const grNumber = `ELX-GR-${grDate}-${sequence}`;

            let locationId = null;
            if (body.location) {
                const locationResult = await transaction.request()
                    .input('locationName', sql.NVarChar, body.location)
                    .query(`SELECT id FROM Locations WHERE name = @locationName`);
                if (locationResult.recordset.length === 0) {
                    throw new Error(`Location "${body.location}" not found in database.`);
                }
                locationId = locationResult.recordset[0].id;
            }

            const staffResult = await transaction.request()
                .input('displayName', sql.NVarChar, body.receivedBy)
                .query(`SELECT id FROM Staff WHERE display_name = @displayName`);
            if (staffResult.recordset.length === 0) {
                throw new Error(`Staff member "${body.receivedBy}" not found`);
            }
            const userId = staffResult.recordset[0].id;

            const now = new Date().toISOString();
            const receiptResult = await transaction.request()
                .input('grNumber', sql.NVarChar, grNumber)
                .input('supplier', sql.NVarChar, body.supplier)
                .input('site', sql.NVarChar, body.site)
                .input('contractor', sql.NVarChar, body.contractor || null)
                .input('po', sql.NVarChar, body.po || null)
                .input('reference', sql.NVarChar, body.reference || null)
                .input('connote', sql.NVarChar, body.connote || null)
                .input('notes', sql.NVarChar, body.notes || null)
                .input('status', sql.NVarChar, 'Goods Received')
                .input('locationId', sql.Int, locationId)
                .input('userId', sql.Int, userId)
                .input('displayName', sql.NVarChar, body.receivedBy)
                .input('receivedAt', sql.DateTime2, now)
                .query(`
                    INSERT INTO FreightReceipts (
                        gr_number, supplier, delivery_site, bhp_contractor_name,
                        po_number, other_reference, connote, notes,
                        current_status, current_location_id,
                        received_by_user_id, received_by_display_name, received_at_utc
                    )
                    OUTPUT INSERTED.id
                    VALUES (
                        @grNumber, @supplier, @site, @contractor,
                        @po, @reference, @connote, @notes,
                        @status, @locationId,
                        @userId, @displayName, @receivedAt
                    )
                `);
            const receiptId = receiptResult.recordset[0].id;

            for (const item of body.items) {
                await transaction.request()
                    .input('receiptId', sql.BigInt, receiptId)
                    .input('itemType', sql.NVarChar, item.type || 'Other')
                    .input('quantity', sql.Int, Number(item.qty) || 1)
                    .input('weight', sql.Decimal(10,2), Number(item.weight) || 0)
                    .query(`
                        INSERT INTO FreightItems (receipt_id, item_type, quantity, weight_kg)
                        VALUES (@receiptId, @itemType, @quantity, @weight)
                    `);
            }

            await transaction.request()
                .input('receiptId', sql.BigInt, receiptId)
                .input('eventType', sql.NVarChar, 'GOODS_RECEIVED')
                .input('newStatus', sql.NVarChar, 'Goods Received')
                .input('newLocationId', sql.Int, locationId)
                .input('userId', sql.Int, userId)
                .input('displayName', sql.NVarChar, body.receivedBy)
                .input('performedAt', sql.DateTime2, now)
                .input('note', sql.NVarChar, 'Supplier freight received at ELX Largs North depot')
                .query(`
                    INSERT INTO LifecycleEvents (
                        receipt_id, event_type,
                        previous_status, new_status,
                        previous_location_id, new_location_id,
                        performed_by_user_id, performed_by_display_name,
                        performed_at_utc, note
                    )
                    VALUES (
                        @receiptId, @eventType,
                        NULL, @newStatus,
                        NULL, @newLocationId,
                        @userId, @displayName,
                        @performedAt, @note
                    )
                `);

            const rawToken = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

            await transaction.request()
                .input('receiptId', sql.BigInt, receiptId)
                .input('tokenHash', sql.Char(64), tokenHash)
                .query(`
                    INSERT INTO PublicReceiptTokens (receipt_id, token_hash)
                    VALUES (@receiptId, @tokenHash)
                `);

            await transaction.commit();

            const publicUrl = `${process.env.PUBLIC_RECEIPT_BASE_URL || 'https://receipt.energylogistix.com.au/r'}/${rawToken}`;

            context.res = {
                status: 201,
                body: JSON.stringify({
                    grNumber: grNumber,
                    receiptId: receiptId,
                    supplier: body.supplier,
                    site: body.site,
                    location: body.location || null,
                    receivedBy: body.receivedBy,
                    receivedAt: now,
                    itemCount: body.items.length,
                    totalQty: body.items.reduce((a, i) => a + Number(i.qty || 0), 0),
                    totalWeight: body.items.reduce((a, i) => a + Number(i.weight || 0), 0),
                    receiptUrl: publicUrl,
                    token: rawToken
                })
            };

        } catch (error) {
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        context.log.error('Error creating receipt:', error);
        context.res = {
            status: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
}
