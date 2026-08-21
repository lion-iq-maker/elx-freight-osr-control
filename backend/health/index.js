module.exports = async function (context, req) {
    try {
        context.log('Health endpoint called');
        context.res = {
            status: 200,
            body: JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() })
        };
    } catch (error) {
        context.log.error('Error in health function:', error);
        context.res = {
            status: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};