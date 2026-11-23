const sql = require('mssql');

module.exports = async function (context, req) {
    const connectionString = process.env.SQL_CONNECTION_STRING;
    if (!connectionString) {
        context.res = { status: 500, body: JSON.stringify({ error: 'SQL connection string missing' }) };
        return;
    }
    try {
        const pool = await sql.connect(connectionString);

        const normalizeName = value =>
            String(value || '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

        const looksLikeFreightInstruction = value => {
            const normalized = normalizeName(value);
            if (!normalized) return true;

            const freightWords = new Set([
                'pallet','crate','carton','bundle','stillage','parcel',
                'satchel','basket','ibc','freight','package','pkg','qty',
                'weight','delivery','deliver','ship','shipping','consignment',
                'connote','reference','ref'
            ]);

            const first = normalized.split(' ')[0];
            return freightWords.has(first);
        };

        if (req.method === 'DELETE') {
            const name = String((req.body || {}).name || '').trim();
            if (!name) {
                context.res = { status: 400, body: JSON.stringify({ error: 'name is required' }) };
                return;
            }

            const result = await pool.request()
                .input('name', sql.NVarChar(200), name)
                .query(`
                    UPDATE dbo.Suppliers
                    SET is_active = 0,
                        updated_at_utc = GETUTCDATE()
                    WHERE name = @name;

                    SELECT @@ROWCOUNT AS affected;
                `);

            context.res = {
                status: result.recordset[0].affected ? 200 : 404,
                body: JSON.stringify({ success: result.recordset[0].affected > 0 })
            };
            return;
        }

        if (req.method === 'POST') {
            const name = String((req.body || {}).name || '').trim();
            if (!name) {
                context.res = { status: 400, body: JSON.stringify({ error: 'name is required' }) };
                return;
            }

            if (looksLikeFreightInstruction(name)) {
                context.res = {
                    status: 400,
                    body: JSON.stringify({ error: 'Freight instruction text cannot be saved as a Supplier' })
                };
                return;
            }

            const siteCheck = await pool.request()
                .input('siteName', sql.NVarChar(200), name)
                .query(`
                    SELECT TOP 1 id
                    FROM dbo.DeliverySites
                    WHERE is_active = 1
                      AND LOWER(LTRIM(RTRIM(name))) = LOWER(LTRIM(RTRIM(@siteName)))
                `);

            if (siteCheck.recordset.length) {
                context.res = {
                    status: 400,
                    body: JSON.stringify({ error: 'Delivery Site values cannot be saved as Suppliers' })
                };
                return;
            }

            const result = await pool.request()
                .input('name', sql.NVarChar(200), name)
                .query(`
                    IF EXISTS (SELECT 1 FROM dbo.Suppliers WHERE name = @name)
                    BEGIN
                        UPDATE dbo.Suppliers SET is_active = 1, updated_at_utc = GETUTCDATE()
                        WHERE name = @name;
                        SELECT id, name, is_active AS isActive FROM dbo.Suppliers WHERE name = @name;
                    END
                    ELSE
                    BEGIN
                        INSERT INTO dbo.Suppliers (name, is_active)
                        OUTPUT INSERTED.id, INSERTED.name, INSERTED.is_active AS isActive
                        VALUES (@name, 1);
                    END
                `);

            context.res = { status: 200, body: JSON.stringify({ supplier: result.recordset[0] }) };
            return;
        }

        const result = await pool.request().query(`
            SELECT id, name, is_active AS isActive
            FROM dbo.Suppliers s
            WHERE s.is_active = 1
              AND NOT EXISTS (
                  SELECT 1
                  FROM dbo.DeliverySites d
                  WHERE d.is_active = 1
                    AND LOWER(LTRIM(RTRIM(d.name))) = LOWER(LTRIM(RTRIM(s.name)))
              )
            ORDER BY s.name ASC
        `);
        context.res = { status: 200, body: JSON.stringify({ suppliers: result.recordset }) };
    } catch (error) {
        context.log.error('Suppliers endpoint error:', error);
        context.res = { status: 500, body: JSON.stringify({ error: error.message }) };
    }
};