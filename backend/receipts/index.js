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

    const body = req.body || {};

    // Required fields: supplier, site, receivedBy, items
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
            // Generate GR number
            const grDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const countResult = await transaction.request().query(
                `SELECT COUNT(*) AS count FROM FreightReceipts WHERE gr_number LIKE 'ELX-GR-${grDate}-%'`
            );
            const sequence = String(Number(countResult.recordset[0].count) + 1).padStart(5, '0');
            const grNumber = `ELX-GR-${grDate}-${sequence}`;

            // --- Location is optional. If provided, look it up; if not, set to NULL ---
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

            // Staff lookup
            const staffResult = await transaction.request()
                .input('displayName', sql.NVarChar, body.receivedBy)
                .query(`SELECT id FROM Staff WHERE display_name = @displayName`);
            if (staffResult.recordset.length === 0) {
                throw new Error(`Staff member "${body.receivedBy}" not found`);
            }
            const userId = staffResult.recordset[0].id;

            // Insert receipt
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
                .input('locationId', sql.Int, locationId) // can be NULL
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

            // Insert items
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

            // Insert lifecycle event (location may be NULL)
            await transaction.request()
                .input('receiptId', sql.BigInt, receiptId)
                .input('eventType', sql.NVarChar, 'GOODS_RECEIVED')
                .input('newStatus', sql.NVarChar, 'Goods Received')
                .input('newLocationId', sql.Int, locationId) // can be NULL
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

            // Generate token
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
};