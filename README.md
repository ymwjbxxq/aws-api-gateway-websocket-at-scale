# WebSocket APIs in Amazon API Gateway #

A while ago, I played around with [websocket api](https://github.com/ymwjbxxq/aws-api-gateway-websocket) and found out that this "hello world" example does not work at all if you have decent traffic on your website or at least I was expecting to deliver a message with a certain number of active user in a faster manner way.
Of course, there are alternatives and more suitable solutions, like using a cluster with socket.io and socke.io-redis adaptor, which uses Redis as a message broker to pass messages between each Node.js process.
A client connected through the load balancer sends a message to one Node.js process in one container. Then, it broadcasts the message using Redis to the other Node.js process, which sends the message back down to the other connected client but, I wanted to push the limit in a serverless way.

### Architecture ###

![picture](https://github.com/ymwjbxxq/aws-api-gateway-websocket-at-scale/blob/master/websocket.png)

### Goal ###

We want to broadcast a message to all the users, and this message must be received not in minutes but a few seconds. 

### Problem at scale ###

If you want to deliver the message in seconds and not in minutes, you need to be aware of the following:

* Lambda has a fixed throughput 
* SQS API has "nearly unlimited" API calls per second, but, at some point, it generates "too many connection errors."
* Amazon API Gateway WebSocket cannot use a queue, so onConnect and onDisconnect could hit the bursts limit

### Problem ###

Once a user is connecting, the WebSocket connectionId is saved into DynamoDB. You will end up with a table with 300k or 600k or more active connections. If you want to broadcast a message to all active connections, you need to load them and send the message to each connection.
With this logic in place, the Lambda function that loads all the connectionIds will take a while and processing all the connectionIds in parallel will take more than a bit, which is the problem with the Lambda throughput.

You can split "the load all connections" and "the broadcasting" but, now you hit the limit of SQS sendMessage and even do you do it in parallel, you still have the Lambda throughput problem. 

### Horizontal scaling ###

To go around the throughput limitation, we need to scale horizontally, and to do so, we need to act at:

* Lambda Query: where we want to load a batch of connections in parallel. 
* Lambda PostMessage: where you want to broadcast the message to a small batch of connections

To achieve the horizontal scaling, I have associated connections to "partition", and in this example is a table in DynamoDB made of two fields "partitionId, connectionCount"

The partitionId can be what you want. I use numbers from 1...to…2500
When a user is connecting on the Lambda onConnect I associate a connection to a partitionId with less connectionCount as possible (trying to spread the load to all 2500 partitions)

When I want to broadcast my message to all active connections, the Lambda Swarm send out 2500 messages containing "partitionId, message" to an SQS queue that trigger Lambda Query that will take care to load all the connections for a particular partitionId.

Each lambda invocation (we could have a max of 250 concurrent requests) can read up to 10 messages for each SQS batch so, we can run 10 small parallel queries to DynamoDB and load just small portions of connections.

Let's assume that each query for each partition return 100 connections. We will have a total of 1000 connections to send out for each invocation.

You can send all the connections to one queue, but you will have too many messages at scale, and it will take time to go through all the messages with a batch of 10.

The solution is also to scale the queues, and so, instead, to send all messages to one queue. It will help if you spread the load into many queues (I used 10)

![picture](https://github.com/ymwjbxxq/aws-api-gateway-websocket-at-scale/blob/master/queue.png)

Now each queue could have 1 subscriber Lambda PostMessage or multiple.

If you have one subscriber, you risk hitting the account burst limit, so the best scale is to have multiple accounts with higher quotas and subscribe to each queue from a subscriber spread in various accounts (of course, you need to see what you want to achieve)

![picture](https://github.com/ymwjbxxq/aws-api-gateway-websocket-at-scale/blob/master/queue_stats.png)

### Improvements ###

* Use multiple accounts where you spread the onConnect requests using Route53 etc.
* Use DAX to improve query times.
* Subscribe the queues with multiple accounts to get the max throughput
* Use Lambda provisioned concurrency to keep lambda warms if you know when you have spikes etc.

### Note ###

In this example, I did not put the code of:

* Lambda onConnect
* Lambda onDisconnect 
* Lambda deleteStale 

They take care to add and delete the connectionId from DynamoDB and increase and decrease the connectionCount at the partition level.

Activating DynamoDB Stream on the table, you can increase/decrease the partition count:

Increasing:
"`javascript
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
"`javascript
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
