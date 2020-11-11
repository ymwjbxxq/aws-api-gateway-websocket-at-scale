import DynamoDB, { BatchWriteItemInput } from "aws-sdk/clients/dynamodb";
import SQS, { SendMessageBatchRequest, SendMessageBatchRequestEntry } from "aws-sdk/clients/sqs";
import ApiGatewayManagementApi from "aws-sdk/clients/apigatewaymanagementapi";
import AWSXRay, { Segment, Subsegment } from "aws-xray-sdk-core";
import * as uuid from "uuid";

const dynamoDbClient = new DynamoDB.DocumentClient();
const sqs = new SQS({ region: process.env.AWS_REGION });
AWSXRay.captureAWSClient(sqs);
AWSXRay.captureAWSClient((dynamoDbClient as any).service);

export const handler = async (event) => {
  console.log(event)
  const rootSegment = AWSXRay.getSegment() as Segment;

  const apigwManagementApi = new ApiGatewayManagementApi({
    apiVersion: "2018-11-29",
    endpoint: "xxxxxxx.execute-api.eu-central-1.amazonaws.com/production"
  });
  const connectionsToDelete: any[] = [];
  const subsegment: Subsegment = rootSegment.addNewSubsegment("## sending");
  await Promise.all(event.Records.map(async (record: any) => {
    const sqsMessage = JSON.parse(record.body);
    try {
      await apigwManagementApi.postToConnection({
        ConnectionId: sqsMessage.connectionId,
        Data: `${sqsMessage.messageToSend} sent at ${new Date().toISOString()}`
      }).promise();
    } catch (error) {
      if (error.statusCode === 410) {
        connectionsToDelete.push(sqsMessage.connectionId);
      } else {
        subsegment.addError(error);
      }
    }

    subsegment.addMetadata("connections", event.Records.length);
  }));
  subsegment.close();

  if (connectionsToDelete.length > 0) {
    await send(connectionsToDelete, rootSegment);
  }

  return "ok";
};

async function send(connections: any[], rootSegment: Segment): Promise<void> {
  const subsegment: Subsegment = rootSegment.addNewSubsegment("## sqs.sendStale");
  const fullTraceId = `Root=${rootSegment.trace_id};Parent=${subsegment.id};Sampled=1`;
  const batchEntries: SendMessageBatchRequestEntry[] = connections.map((connectionId: string) => {
    const entry: SendMessageBatchRequestEntry = {
      Id: uuid.v4(),
      MessageBody: connectionId
    };
    entry["MessageSystemAttributes"] = {
      "AWSTraceHeader": {
        "StringValue": fullTraceId,
        "DataType": "String"
      }
    };

    return entry;
  });
  const message: SendMessageBatchRequest = {
    QueueUrl: process.env.sqsUrl,
    Entries: batchEntries
  };

  try {
    await sqs.sendMessageBatch(message).promise();
  } catch (error) {
    subsegment.addError(error);
  }

  subsegment.close();
}
