const { Readable } = require('stream');

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

    // 1. Check that an image file was uploaded
    if (!req.files || !req.files.file) {
        context.res = {
            status: 400,
            body: JSON.stringify({ error: 'No image file uploaded. Use "file" field.' })
        };
        return;
    }

    const file = req.files.file;
    const buffer = file.buffer; // Buffer of the image

    try {
        // 2. Build the analyze request
        const modelId = 'prebuilt-document';
        const apiVersion = '2023-07-31';
        const analyzeUrl = `${endpoint}/formrecognizer/documentModels/${modelId}:analyze?api-version=${apiVersion}`;

        // Prepare form data with the image
        const formData = new FormData();
        const stream = Readable.from(buffer);
        formData.append('file', stream, { filename: file.originalname || 'label.jpg' });

        // 3. Send the request to Azure Document Intelligence
        const response = await fetch(analyzeUrl, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': key,
            },
            body: formData,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Azure API error: ${response.status} - ${errorText}`);
        }

        // 4. Get the operation URL from the response headers
        const operationLocation = response.headers.get('operation-location');
        if (!operationLocation) {
            throw new Error('No operation-location header returned from Azure.');
        }

        // 5. Poll for completion
        let result = null;
        let attempts = 0;
        const maxAttempts = 30;

        while (attempts < maxAttempts) {
            const pollResponse = await fetch(operationLocation, {
                headers: {
                    'Ocp-Apim-Subscription-Key': key,
                },
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
            // Still running – wait 1 second
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }

        if (!result) {
            throw new Error('Analysis timed out after 30 seconds.');
        }

        // 6. Extract key-value pairs from the result
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

        // Also try to extract from general key-value pairs (if any)
        if (result.keyValuePairs) {
            for (const kv of result.keyValuePairs) {
                const key = kv.key?.content || '';
                const value = kv.value?.content || '';
                if (key && value) {
                    keyValuePairs[key] = value;
                }
            }
        }

        // 7. Map to fields expected by the frontend
        const extracted = {
            supplier: keyValuePairs['Supplier'] || keyValuePairs['Vendor'] || keyValuePairs['Sender'] || '',
            po: keyValuePairs['PO Number'] || keyValuePairs['Purchase Order'] || keyValuePairs['PO'] || '',
            site: keyValuePairs['Site'] || keyValuePairs['Destination'] || keyValuePairs['Delivery Site'] || '',
            connote: keyValuePairs['Connote'] || keyValuePairs['Consignment'] || keyValuePairs['Tracking'] || '',
            reference: keyValuePairs['Reference'] || keyValuePairs['Ref'] || keyValuePairs['Docket'] || '',
            qty: keyValuePairs['Quantity'] || keyValuePairs['Qty'] || keyValuePairs['Items'] || '',
            // Also include raw full text for debugging
            rawText: result.content || '',
        };

        // 8. Return the extracted data
        context.res = {
            status: 200,
            body: JSON.stringify({
                success: true,
                extracted: extracted,
                confidence: 0.8, // We can estimate, but Azure doesn't give per-field confidence easily
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