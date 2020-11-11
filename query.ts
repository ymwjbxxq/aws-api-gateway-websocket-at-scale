import DynamoDB from "aws-sdk/clients/dynamodb";
import AWSXRay, { Segment, Subsegment } from "aws-xray-sdk-core";
import SQS, { SendMessageBatchRequest, SendMessageBatchRequestEntry } from "aws-sdk/clients/sqs";
import * as uuid from "uuid";

const dynamoDbClient = new DynamoDB.DocumentClient();
const sqs = new SQS({ region: process.env.AWS_REGION });
AWSXRay.captureAWSClient(sqs);
AWSXRay.captureAWSClient((dynamoDbClient as any).service);
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;

export const handler = async (event) => {
  const rootSegment = AWSXRay.getSegment() as Segment;
  Promise.all(event.Records.map(async (record: any) => {
    const sqsMessage = JSON.parse(record.body);
    const connections: string[] = await getConnections(sqsMessage.partitionId, rootSegment);
    if (connections.length > 0) {
      await send(connections, rootSegment, sqsMessage.messageToSend, sqsMessage.partitionId);
    }
  }));

  return "ok";
};

async function getConnections(partitionId: string, rootSegment: Segment): Promise<string[]> {
  const subsegment: Subsegment = rootSegment.addNewSubsegment(`## load partition ${partitionId}`);
  const connections: string[] = [];
  try {
    const query: any = {
      TableName: "poc-websocket",
      IndexName: "partitionId-appId-index",
      KeyConditionExpression: "appId = :a and partitionId = :b",
      ProjectionExpression: "connectionId",
      ExpressionAttributeValues: {
        ":a": "XXX",
        ":b": partitionId.toString()
      }
    };
    let document = await dynamoDbClient.query(query).promise();

    document.Items.map((connection: any) => connections.push(connection.connectionId));
    while (document.LastEvaluatedKey !== undefined) {
      query.ExclusiveStartKey = document.LastEvaluatedKey;
      document = await dynamoDbClient.query(query).promise();
      document.Items.map((connection: any) => connections.push(connection.connectionId));
    }
    subsegment.addMetadata("connections", connections.length);
  } catch (error) {
    subsegment.addError(`Partition: ${partitionId} Error: ${error}`);
  }
  finally {
    subsegment.close();
  }

  return connections;
}

async function send(connections: any[], rootSegment: Segment, messageToSend: string, partitionId: string): Promise<void> {
  const subsegment: Subsegment = rootSegment.addNewSubsegment(`## sqs.partition ${partitionId}`);
  subsegment.addMetadata("connections", connections.length);
  const fullTraceId = `Root=${rootSegment.trace_id};Parent=${subsegment.id};Sampled=1`;
  const chunks = chunkArray<any>(connections, 10);
  await Promise.all(chunks.map(async (chunk: any[]) => {
    const batchEntries: SendMessageBatchRequestEntry[] = chunk.map((connectionId: string) => {
      const entry: SendMessageBatchRequestEntry = {
        Id: uuid.v4(),
        MessageBody: JSON.stringify({
          messageToSend,
          connectionId
        })
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
      QueueUrl: SQS_QUEUE_URL + pickRandomQueue(Number(partitionId)),
      Entries: batchEntries
    };

    try {
      await sqs.sendMessageBatch(message).promise();
    } catch (error) {
      subsegment.addError(`Partition: ${partitionId} Error: ${error}`);
    }
  }));
  subsegment.close();
}

function pickRandomQueue(partitionId: number): number {
  const queueArray = [250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500];

  for (let index = 0; index < queueArray.length; index++) {
    const element = queueArray[index];
    if (partitionId < element) {
      return index;
    }
  }

  return 0;
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunked_arr: T[][] = [];
  let index = 0;
  while (index < array.length) {
    chunked_arr.push(array.slice(index, size + index));
    index += size;
  }
  return chunked_arr;
}
