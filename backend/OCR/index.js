module.exports = async function (context, req) {
    const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
    const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;

    if (!endpoint || !key) {
        context.res = {
            status: 500,
            body: JSON.stringify({ error: 'Missing Azure AI Document Intelligence credentials' })
        };
        return;
    }

    const body = req.body || {};
    const imageBase64 = body.image;

    if (!imageBase64) {
        context.res = {
            status: 400,
            body: JSON.stringify({ error: 'No image provided. Send {"image": "base64string"}' })
        };
        return;
    }

    try {
        const imageBuffer = Buffer.from(imageBase64, 'base64');

        const modelId = 'prebuilt-document';
        const apiVersion = '2023-07-31';
        const analyzeUrl = `${endpoint}/formrecognizer/documentModels/${modelId}:analyze?api-version=${apiVersion}`;

        const response = await fetch(analyzeUrl, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': key,
                'Content-Type': 'application/octet-stream',
            },
            body: imageBuffer,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Azure API error: ${response.status} - ${errorText}`);
        }

        const operationLocation = response.headers.get('operation-location');
        if (!operationLocation) {
            throw new Error('No operation-location header returned from Azure.');
        }

        let result = null;
        let attempts = 0;
        const maxAttempts = 30;

        while (attempts < maxAttempts) {
            const pollResponse = await fetch(operationLocation, {
                headers: { 'Ocp-Apim-Subscription-Key': key }
            });
            if (!pollResponse.ok) {
                throw new Error(`Polling error: ${pollResponse.status}`);
            }
            const statusData = await pollResponse.json();
            if (statusData.status === 'succeeded') {
                result = statusData.analyzeResult;
                break;
            } else if (statusData.status === 'failed') {
                throw new Error(`Analysis failed: ${statusData.error?.message || 'Unknown error'}`);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }

        if (!result) {
            throw new Error('Analysis timed out after 30 seconds.');
        }

        // Helper to normalize key names
        const normalizeKey = (key) => {
            if (!key) return '';
            return key.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
        };

        // Build a normalized map of all key-value pairs
        const allPairs = {};
        if (result.keyValuePairs) {
            for (const kv of result.keyValuePairs) {
                const key = kv.key?.content || '';
                const value = kv.value?.content || '';
                if (key && value) {
                    const normalized = normalizeKey(key);
                    allPairs[normalized] = value;
                }
            }
        }
        // Also include fields from documents
        if (result.documents && result.documents.length > 0) {
            const doc = result.documents[0];
            if (doc.fields) {
                for (const [key, field] of Object.entries(doc.fields)) {
                    if (field.content) {
                        const normalized = normalizeKey(key);
                        allPairs[normalized] = field.content;
                    }
                }
            }
        }

        // Define mapping with multiple synonyms
        const map = {
            supplier: ['supplier', 'vendor', 'sender', 'from', 'consignor', 'shipper', 'shipped by'],
            po: ['po number', 'purchase order', 'po', 'p/o', 'order number'],
            site: ['site', 'destination', 'delivery site', 'location', 'consignee', 'deliver to'],
            contractor: ['contractor', 'bhp contractor', 'contractor name', 'company'],
            connote: ['connote', 'consignment', 'tracking', 'tracking number', 'waybill', 'airway bill'],
            reference: ['reference', 'ref', 'docket', 'booking', 'order ref', 'customer ref'],
            qty: ['quantity', 'qty', 'items', 'pieces', 'pcs', 'cartons', 'unit count'],
            weight: ['weight', 'kg', 'gross weight', 'net weight', 'mass'],
            itemType: ['item type', 'type', 'description', 'product', 'goods description']
        };

        const extracted = {};
        for (const [key, synonyms] of Object.entries(map)) {
            for (const syn of synonyms) {
                const normalized = normalizeKey(syn);
                if (allPairs[normalized]) {
                    extracted[key] = allPairs[normalized];
                    break;
                }
            }
            if (!extracted[key]) extracted[key] = ''; // ensure always a string
        }

        // Also keep raw text for debugging
        extracted.rawText = result.content || '';

        context.res = {
            status: 200,
            body: JSON.stringify({
                success: true,
                extracted: extracted,
            })
        };

    } catch (error) {
        context.log.error('OCR error:', error);
        context.res = {
            status: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
