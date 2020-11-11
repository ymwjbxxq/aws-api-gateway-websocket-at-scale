import AWSXRay, { Segment, Subsegment } from "aws-xray-sdk-core";
import SQS, { SendMessageBatchRequest, SendMessageBatchRequestEntry } from "aws-sdk/clients/sqs";
import * as uuid from "uuid";

const sqs = new SQS({ region: process.env.AWS_REGION });
AWSXRay.captureAWSClient(sqs);
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;
const partition = Number(process.env.PARTITION);
// {
//   "message": "do it, do it now",
// }

export const handler = async (event) => {
  const rootSegment = AWSXRay.getSegment() as Segment;
  const partitions = [];
  for (let index = 0; index < partition; index++) {
    partitions.push(index);
  }

  const messageToSend = `${event.message}#${new Date().toISOString()}`;
  await send(partitions, rootSegment, messageToSend);

  return "ok";
};

async function send(partitions: number[], rootSegment: Segment, messageToSend: string): Promise<void> {
  const subsegment: Subsegment = rootSegment.addNewSubsegment("## sqs.send");
  const fullTraceId = `Root=${rootSegment.trace_id};Parent=${subsegment.id};Sampled=1`;
  const chunks = chunkArray<any>(partitions, 10);
  await Promise.all(chunks.map(async (chunk: any[]) => {
    const batchEntries: SendMessageBatchRequestEntry[] = chunk.map((partitionId: string) => {
      const entry: SendMessageBatchRequestEntry = {
        Id: uuid.v4(),
        MessageBody: JSON.stringify({
          messageToSend,
          partitionId
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
      QueueUrl: SQS_QUEUE_URL,
      Entries: batchEntries
    };
    try {
      await sqs.sendMessageBatch(message).promise();
    } catch (error) {
      subsegment.addError(error);
    }
  }));
  subsegment.close();
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
