FROM node:latest
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app
COPY . /usr/src/app
RUN mkdir /usr/src/app/network
EXPOSE 8080
RUN npm install
VOLUME [ "/usr/src/app/network" ]
CMD [ "npm", "start" ]
