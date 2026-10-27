const sql = require('mssql');

module.exports = async function (context, req) {
    const connectionString = process.env.SQL_CONNECTION_STRING;
    if (!connectionString) {
        context.res = {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'SQL connection string missing' })
        };
        return;
    }

    try {
        const pool = await sql.connect(connectionString);

        if (req.method === 'POST') {
            const displayName = String((req.body || {}).displayName || '').trim();

            if (!displayName) {
                context.res = {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'displayName is required' })
                };
                return;
            }

            const result = await pool.request()
                .input('displayName', sql.NVarChar(100), displayName)
                .query(`
                    IF EXISTS (
                        SELECT 1 FROM dbo.Staff
                        WHERE display_name = @displayName
                    )
                    BEGIN
                        UPDATE dbo.Staff
                        SET is_active = 1,
                            updated_at_utc = GETUTCDATE()
                        WHERE display_name = @displayName;

                        SELECT id,
                               display_name AS displayName,
                               role,
                               is_active AS isActive
                        FROM dbo.Staff
                        WHERE display_name = @displayName;
                    END
                    ELSE
                    BEGIN
                        INSERT INTO dbo.Staff (
                            display_name,
                            role,
                            is_active
                        )
                        OUTPUT INSERTED.id,
                               INSERTED.display_name AS displayName,
                               INSERTED.role,
                               INSERTED.is_active AS isActive
                        VALUES (
                            @displayName,
                            'WarehouseUser',
                            1
                        );
                    END
                `);

            context.res = {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ staffMember: result.recordset[0] })
            };
            return;
        }

        const result = await pool.request().query(`
            SELECT id,
                   display_name AS displayName,
                   role,
                   is_active AS isActive
            FROM dbo.Staff
            WHERE is_active = 1
            ORDER BY display_name ASC
        `);

        context.res = {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ staff: result.recordset })
        };
    } catch (error) {
        context.log.error('Staff endpoint error:', error);
        context.res = {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: error.message })
        };
    }
};