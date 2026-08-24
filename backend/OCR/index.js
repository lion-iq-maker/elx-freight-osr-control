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
        // Convert base64 to Buffer
        const imageBuffer = Buffer.from(imageBase64, 'base64');

        // Build the analyze request
        const modelId = 'prebuilt-document';
        const apiVersion = '2023-07-31';
        const analyzeUrl = `${endpoint}/formrecognizer/documentModels/${modelId}:analyze?api-version=${apiVersion}`;

        // Send to Azure Document Intelligence (as bytes)
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

        // Poll for completion
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

        // Extract key-value pairs
        const keyValuePairs = {};
        if (result.documents && result.documents.length > 0) {
            const doc = result.documents[0];
            if (doc.fields) {
                for (const [key, field] of Object.entries(doc.fields)) {
                    if (field.content) {
                        keyValuePairs[key] = field.content;
                    }
                }
            }
        }

        if (result.keyValuePairs) {
            for (const kv of result.keyValuePairs) {
                const key = kv.key?.content || '';
                const value = kv.value?.content || '';
                if (key && value) {
                    keyValuePairs[key] = value;
                }
            }
        }

        // Map to expected fields
        const extracted = {
            supplier: keyValuePairs['Supplier'] || keyValuePairs['Vendor'] || keyValuePairs['Sender'] || '',
            po: keyValuePairs['PO Number'] || keyValuePairs['Purchase Order'] || keyValuePairs['PO'] || '',
            site: keyValuePairs['Site'] || keyValuePairs['Destination'] || keyValuePairs['Delivery Site'] || '',
            connote: keyValuePairs['Connote'] || keyValuePairs['Consignment'] || keyValuePairs['Tracking'] || '',
            reference: keyValuePairs['Reference'] || keyValuePairs['Ref'] || keyValuePairs['Docket'] || '',
            qty: keyValuePairs['Quantity'] || keyValuePairs['Qty'] || keyValuePairs['Items'] || '',
            contractor: keyValuePairs['Contractor'] || keyValuePairs['BHP Contractor'] || '',
            weight: keyValuePairs['Weight'] || keyValuePairs['Kg'] || '',
            itemType: keyValuePairs['Item Type'] || keyValuePairs['Type'] || '',
            rawText: result.content || '',
        };

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
