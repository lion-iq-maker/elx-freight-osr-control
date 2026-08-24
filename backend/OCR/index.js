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

        // ========== NEW EXTRACTION LOGIC ==========
        const rawText = result.content || '';
        const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        const extracted = {
            supplier: '',
            po: '',
            site: '',
            contractor: '',
            connote: '',
            reference: '',
            qty: '',
            weight: '',
            itemType: ''
        };

        // Define mapping: field -> array of possible key substrings (case-insensitive)
        const keyMap = [
            { field: 'supplier', keys: ['supplier', 'sender', 'vendor', 'from', 'shipper'] },
            { field: 'po', keys: ['po number', 'purchase order', 'po', 'p/o'] },
            { field: 'site', keys: ['delivery site', 'site', 'destination', 'location', 'consignee'] },
            { field: 'contractor', keys: ['contractor', 'bhp contractor', 'company'] },
            { field: 'connote', keys: ['connote', 'consignment', 'tracking', 'waybill'] },
            { field: 'reference', keys: ['reference', 'ref', 'docket', 'booking'] },
            { field: 'qty', keys: ['quantity', 'qty', 'items', 'pieces', 'pcs', 'cartons'] },
            { field: 'weight', keys: ['weight', 'kg', 'gross weight', 'net weight'] },
            { field: 'itemType', keys: ['item type', 'type', 'description', 'product'] }
        ];

        // Helper to extract value from a line given a key
        const extractValue = (line, key) => {
            // Try to find the key in the line (case-insensitive)
            const lowerLine = line.toLowerCase();
            const lowerKey = key.toLowerCase();
            const idx = lowerLine.indexOf(lowerKey);
            if (idx === -1) return null;
            // Get the rest of the line after the key
            let rest = line.substring(idx + key.length).trim();
            // Remove leading delimiters like colon, dash, asterisk, slash
            rest = rest.replace(/^[:#\-*\/\s]+/, '').trim();
            return rest || null;
        };

        // First pass: look for key-value on the same line
        for (const line of lines) {
            for (const entry of keyMap) {
                if (extracted[entry.field]) continue; // already found
                for (const key of entry.keys) {
                    if (line.toLowerCase().includes(key.toLowerCase())) {
                        const val = extractValue(line, key);
                        if (val) {
                            extracted[entry.field] = val;
                            break;
                        }
                    }
                }
            }
        }

        // Second pass: if a field is still empty, look for key on one line and value on the next line
        for (let i = 0; i < lines.length - 1; i++) {
            const currentLine = lines[i];
            const nextLine = lines[i + 1];
            for (const entry of keyMap) {
                if (extracted[entry.field]) continue;
                for (const key of entry.keys) {
                    if (currentLine.toLowerCase().includes(key.toLowerCase())) {
                        // Check if the current line has no value (or value is just the key)
                        const valOnSameLine = extractValue(currentLine, key);
                        if (!valOnSameLine || valOnSameLine.length < 3) {
                            // Use the next line as value if it looks like a value (not a key)
                            const nextLower = nextLine.toLowerCase();
                            const isNextLineKey = keyMap.some(e => e.keys.some(k => nextLower.includes(k.toLowerCase())));
                            if (!isNextLineKey && nextLine.length > 1) {
                                extracted[entry.field] = nextLine;
                            }
                        }
                        break;
                    }
                }
            }
        }

        // Clean up extracted values: remove common noise like trailing asterisks or slashes
        for (const [field, value] of Object.entries(extracted)) {
            if (value) {
                extracted[field] = value.replace(/\s*[\/\*]+\s*$/, '').trim();
            }
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
