# WebSocket APIs in Amazon API Gateway #

A while ago a play around with [websocket api]( https://bitbucket.org/DanBranch/api-gateway-websocket/) and find out that this “hello world” example does not works at all if you have a decent traffic on your website.

### Architecture ###

![picture](https://bitbucket.org/DanBranch/api-gateway-websocket-at-scale/downloads/websocket.png)

### Goal ###

We want to broadcast a message to all the users and this message must be received not in minutes but in few seconds. 

### Problem at scale ###

If you want to deliver the message in seconds and not in minutes you need to be aware of the following:
* Lambda has a fix throughput 
* SQS API have “nearly unlimited” API calls per seconds but, at some point it generates “too many connection error”
* Amazon API Gateway WebSocket cannot use queue so onConnect and onDisconnect could hit the bursts limit

### Problem ###

Once a user is connecting the WebSocket connectionId is save into DynamoDB so, you will end up with a table with 300k or 600k or more active connections. If you want to broadcast a message to all you need to load all the connections and send the message to each connection.
With this logic in place the Lambda function that load all the connectionIds will take a while and processing all the connectionIds in Parallel will take more than a while and this is the problem with the Lambda throughput.

You can split “the load all connections” and “the broadcasting” but now you hit the limit of SQS sendMessage and even do you do in parallel you still have the Lambda throughput problem. 

### Horizontal scaling ###

To go around the throughput limitation we need to scale horizontally and to do so we need to act at:
* Lambda Query: where we want to load batch of connections in parallel. 
* Lambda PostMessage: where you want to broadcast the message to small batch of connections

To achieve the horizontal scaling, I have associated connections to “partition” and in this example is a table in DynamoDB made of two fields “partitionId, connectionCount”

The partitionId can be what you want, I use numbers from 1…..to…..2500
When a user is connecting on the onConnect Lambda I associate a connection to a partitionId with less connectionCount (trying to spread the load to all 2500 partitions)

Now when I want to broadcast my message to all, the Lambda Swarm send out 2500 messages containing “partitionId, message” to an SQS queue that trigger Lambda Query that will take care to load all the connections for a particular partitionId.

Each lambda invocation (we could have max 250 concurrent invocations) can read up to 10 messages for each SQS batch so, now we are able to run 10 small parallel queries to DynamoDB and load just small portions of connections.

Let’s assume that each query for each partition return 100 connections, we will have a total of 1000 connections to send out for each invocation.

You can send all the connections to one queue but at scale you will have too many messages and it will take time to go through all the messages a batch of 10.

The solution is to scale also the queues and so, instead to send all messages to one queue, you need to spread the load into many queues (I used 10)

![picture](https://bitbucket.org/DanBranch/api-gateway-websocket-at-scale/downloads/queue.png)

Now each queue could have 1 subscriber Lambda PostMessage or multiple.

If you have one subscriber you risk to hit the account burst limit so the best at scale is to have multiple accounts with higher quotas and subscribe each queue from a subscriber spread in multiple accounts (of course you need to see what you want to achieve)

![picture](https://bitbucket.org/DanBranch/api-gateway-websocket-at-scale/downloads/queue_stats.png)

### Improvements ###

* Use multiple accounts where you spread the onConnect requests using Route53 etc.
* Use DAX to improve query times.
* Subscribe the queues with multiple accounts to get the max throughput
* Use Lambda provisioned concurrency to keep lambda warms if you know that you have spikes etc.

### Note ###

In this example I did not put code of:
* Lambda onConnect
* Lambda onDisconnect 
* Lambda deleteStale 

They are taking care to add and delete the connectionId from DynamoDB and to increase and decrease the connectionCount at partition level.

Activating DynamoDB Stream on the table you are able to increase/decrease the partition count:

Increasing:
```javascript
const params = {
    TableName: "poc-websocket-partition",
    Key: {
      "partitionId": partitionId,
      "appId": "xxxx"
    },
    UpdateExpression: "set connectionCount = if_not_exists(connectionCount, :zero) + :incr",
    ExpressionAttributeValues: {
      ":incr": 1,
      ":zero": 0
    },
    ReturnValues: "UPDATED_NEW"

  };
  await dynamoDbClient. put(params).promise();
```

Descreasing:
```javascript
const params = {
    TableName: "poc-websocket-partition",
    Key: {
      "partitionId": partitionId,
      "appId": "xxxx"
    },
    UpdateExpression: "ADD connectionCount :incr",
    ExpressionAttributeValues: {
      ":incr": -1
    },
    ReturnValues: "UPDATED_NEW"

  };
  await dynamoDbClient.update(params).promise();
```
 