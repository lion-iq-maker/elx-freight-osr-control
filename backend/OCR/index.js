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

        // ========== SAFE EXTRACTION ==========
        const allPairs = {};

        // 1. From keyValuePairs
        if (result.keyValuePairs && Array.isArray(result.keyValuePairs)) {
            for (const kv of result.keyValuePairs) {
                const key = kv.key?.content ?? '';
                const value = kv.value?.content ?? '';
                if (key && value) {
                    const normalized = key.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
                    allPairs[normalized] = value;
                }
            }
        }

        // 2. From documents.fields
        if (result.documents && Array.isArray(result.documents) && result.documents.length > 0) {
            const doc = result.documents[0];
            if (doc.fields) {
                for (const [fieldKey, field] of Object.entries(doc.fields)) {
                    const content = field?.content ?? '';
                    if (fieldKey && content) {
                        const normalized = fieldKey.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
                        allPairs[normalized] = content;
                    }
                }
            }
        }

        // 3. Raw text fallback
        const rawText = result.content || '';
        // ✅ FIXED: safely handle match[1]
        const fallbackExtract = (pattern) => {
            if (!rawText) return '';
            const regex = new RegExp(pattern + '\\s*[:#\\-]?\\s*(.*?)(?:\\n|$)', 'i');
            const match = rawText.match(regex);
            return (match && match[1]) ? match[1].trim() : '';
        };

        // 4. Map with synonyms
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
            let found = '';
            for (const syn of synonyms) {
                const normalized = syn.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
                if (allPairs[normalized]) {
                    found = allPairs[normalized];
                    break;
                }
            }
            if (!found) {
                const pattern = synonyms.join('|');
                found = fallbackExtract(pattern);
            }
            extracted[key] = found || '';
        }

        extracted.rawText = rawText;

        context.log('📦 Extracted from Azure:', extracted);

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
